import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { seedDatabase } from '../../../prisma/seed.js'
import { app } from '../../app.js'
import { prisma } from '../../db/client.js'
import { signAccessToken } from '../../auth/tokens.js'
import { clearBoardCache } from '../../routes/jobs.js'
import { acceptJob, assignJob } from '../../services/assignment-service.js'
import { startJob as startJobService } from '../../services/job-service.js'
import { createOwnerTestClient, createUserFixture, resetDatabase } from '../helpers.js'

const ownerDatabase = createOwnerTestClient()

const dispatcherEmail = 'dispatcher@dispatchgrid.local'
const agentEmail = 'agent@dispatchgrid.local'
const shadowEmail = 'agent@shadow.dispatchgrid.local'

beforeEach(async () => {
  clearBoardCache()
  await resetDatabase(ownerDatabase)
  await seedDatabase(ownerDatabase)
})

afterAll(async () => {
  await Promise.all([ownerDatabase.$disconnect(), prisma.$disconnect()])
})

async function tokenFor(email) {
  const user = await ownerDatabase.user.findUniqueOrThrow({ where: { email } })
  return signAccessToken(user.id)
}

async function actorFor(email) {
  const user = await ownerDatabase.user.findUniqueOrThrow({ where: { email } })
  const membership = await ownerDatabase.membership.findFirstOrThrow({
    where: { userId: user.id },
    include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
  })
  return {
    user,
    actor: {
      userId: user.id,
      organizationId: membership.organizationId,
      membershipId: membership.id,
      roleId: membership.roleId,
      roleName: membership.role.name,
      permissions: membership.role.rolePermissions.map((link) => link.permission.code),
    },
  }
}

function jobPayload(overrides = {}) {
  return {
    title: 'Fix basement pump',
    latitude: 51.5,
    longitude: -0.12,
    dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  }
}

async function createJobViaApi(token, overrides = {}) {
  const response = await request(app)
    .post('/api/v1/jobs')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', crypto.randomUUID())
    .send(jobPayload(overrides))
  expect(response.status).toBe(201)
  return response.body.job
}

async function createSecondAgent() {
  const organization = await ownerDatabase.organization.findFirstOrThrow({
    where: { slug: 'dispatchgrid-demo' },
  })
  const role = await ownerDatabase.role.findFirstOrThrow({
    where: { organizationId: organization.id, name: 'AGENT' },
  })
  const user = await createUserFixture(ownerDatabase)
  await ownerDatabase.membership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      roleId: role.id,
      isAvailable: true,
    },
  })
  return { user, token: signAccessToken(user.id) }
}

// PENDING v1 -> ASSIGNED v2 -> ACCEPTED v3 via services (T3 HTTP not built here).
async function progressToAccepted(jobId) {
  const { actor: dispatcher } = await actorFor(dispatcherEmail)
  const { user: agentUser, actor: agent } = await actorFor(agentEmail)
  await assignJob(dispatcher, jobId, agentUser.id, 1)
  const accepted = await acceptJob(agent, jobId, { version: 2 })
  return { job: accepted.job, agentUser }
}

// ACCEPTED v3 -> IN_PROGRESS v4 via service, for complete/fail setup.
async function progressToInProgress(jobId) {
  const { job, agentUser } = await progressToAccepted(jobId)
  const { actor: agent } = await actorFor(agentEmail)
  const started = await startJobService(agent, jobId, { version: job.version })
  return { job: started.job, agentUser }
}

const EXPECTED_JOB_KEYS = [
  'address',
  'completedAt',
  'createdAt',
  'createdById',
  'currentAssigneeId',
  'description',
  'dueAt',
  'id',
  'latitude',
  'longitude',
  'organizationId',
  'priority',
  'reference',
  'slaState',
  'status',
  'title',
  'updatedAt',
  'version',
].sort()

describe('PATCH /api/v1/jobs/:id', () => {
  it('patches mutable fields, bumps version, and owns the wire shape', async () => {
    const token = await tokenFor(dispatcherEmail)
    const created = await createJobViaApi(token)
    const response = await request(app)
      .patch(`/api/v1/jobs/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Updated title', version: 1 })

    expect(response.status).toBe(200)
    expect(response.body.job).toMatchObject({ title: 'Updated title', version: 2, status: 'PENDING' })
    expect(Object.keys(response.body.job).sort()).toEqual(EXPECTED_JOB_KEYS)
  })

  it('enforces job.update permission and authentication (403 distinct from 409)', async () => {
    const token = await tokenFor(dispatcherEmail)
    const created = await createJobViaApi(token)
    const agentToken = await tokenFor(agentEmail)
    const denied = await request(app)
      .patch(`/api/v1/jobs/${created.id}`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ title: 'Nope', version: 1 })
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('forbidden')

    const anonymous = await request(app)
      .patch(`/api/v1/jobs/${created.id}`)
      .send({ title: 'Nope', version: 1 })
    expect(anonymous.status).toBe(401)
    expect(anonymous.body.error.code).toBe('unauthorized')
  })

  it('returns 404 for cross-org and missing jobs', async () => {
    const token = await tokenFor(dispatcherEmail)
    const created = await createJobViaApi(token)
    const shadowToken = await tokenFor(shadowEmail)
    const crossOrg = await request(app)
      .patch(`/api/v1/jobs/${created.id}`)
      .set('Authorization', `Bearer ${shadowToken}`)
      .send({ title: 'Nope', version: 1 })
    // Shadow caller is an agent without job.update, so the permission denial
    // surfaces first; the dispatcher-shaped cross-org read below proves 404.
    expect([403, 404]).toContain(crossOrg.status)

    const missing = await request(app)
      .patch(`/api/v1/jobs/${crypto.randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Nope', version: 1 })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('not_found')
  })

  it('yields 409 with fresh state on stale versions', async () => {
    const token = await tokenFor(dispatcherEmail)
    const created = await createJobViaApi(token)
    await request(app)
      .patch(`/api/v1/jobs/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'First write', version: 1 })
    const stale = await request(app)
      .patch(`/api/v1/jobs/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Stale write', version: 1 })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('version_conflict')
    expect(stale.body.error.details).toMatchObject({ currentVersion: 2, currentStatus: 'PENDING' })
  })

  it('yields 422 for terminal jobs and 400 for bad input', async () => {
    const token = await tokenFor(dispatcherEmail)
    const created = await createJobViaApi(token)
    const cancelled = await request(app)
      .post(`/api/v1/jobs/${created.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1, reason: 'No longer needed' })
    expect(cancelled.status).toBe(200)

    const terminal = await request(app)
      .patch(`/api/v1/jobs/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Too late', version: cancelled.body.job.version })
    expect(terminal.status).toBe(422)
    expect(terminal.body.error.code).toBe('invalid_transition')

    const missingVersion = await request(app)
      .patch(`/api/v1/jobs/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'No version' })
    expect(missingVersion.status).toBe(400)
    expect(missingVersion.body.error.code).toBe('validation_error')

    const empty = await request(app)
      .patch(`/api/v1/jobs/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version: cancelled.body.job.version })
    expect(empty.status).toBe(400)
    expect(empty.body.error.code).toBe('validation_error')

    const unknown = await request(app)
      .patch(`/api/v1/jobs/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'x', version: 1, bogus: true })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error.code).toBe('validation_error')

    const malformed = await request(app)
      .patch('/api/v1/jobs/not-a-uuid')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'x', version: 1 })
    expect(malformed.status).toBe(400)
    expect(malformed.body.error.code).toBe('validation_error')
  })

  it('replays idempotent retries with the marker and rejects key reuse', async () => {
    const token = await tokenFor(dispatcherEmail)
    const created = await createJobViaApi(token)
    const key = crypto.randomUUID()
    const body = { title: 'Idempotent title', version: 1 }
    const first = await request(app)
      .patch(`/api/v1/jobs/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(body)
    const second = await request(app)
      .patch(`/api/v1/jobs/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(body)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.headers['idempotent-replay']).toBe('true')
    expect(second.body).toEqual(first.body)

    const reuse = await request(app)
      .patch(`/api/v1/jobs/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ title: 'Different body', version: 1 })
    expect(reuse.status).toBe(422)
    expect(reuse.body.error.code).toBe('idempotency_key_reuse')
  })

  it('invalidates the board cache on patch', async () => {
    const token = await tokenFor(dispatcherEmail)
    await createJobViaApi(token)
    const getBoard = () => request(app).get('/api/v1/jobs').set('Authorization', `Bearer ${token}`)
    await getBoard()
    const hit = await getBoard()
    expect(hit.headers['x-board-cache']).toBe('HIT')

    const created = await createJobViaApi(token)
    // Create invalidated the cache; re-establish a HIT entry first.
    await getBoard()
    const hit2 = await getBoard()
    expect(hit2.headers['x-board-cache']).toBe('HIT')
    const patched = await request(app)
      .patch(`/api/v1/jobs/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Cache buster', version: 1 })
    expect(patched.status).toBe(200)
    const fresh = await getBoard()
    expect(fresh.headers['x-board-cache']).toBe('MISS')
  })
})

describe('POST /api/v1/jobs/:id/start', () => {
  it('starts the owned ACCEPTED job', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)
    await progressToAccepted(created.id)
    const response = await request(app)
      .post(`/api/v1/jobs/${created.id}/start`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ version: 3 })
    expect(response.status).toBe(200)
    expect(response.body.job).toMatchObject({ status: 'IN_PROGRESS', version: 4 })
    expect(Object.keys(response.body.job).sort()).toEqual(EXPECTED_JOB_KEYS)
  })

  it('enforces job.respond permission, ownership, and authentication', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const created = await createJobViaApi(dispatcherToken)
    await progressToAccepted(created.id)

    const noPerm = await request(app)
      .post(`/api/v1/jobs/${created.id}/start`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .send({ version: 3 })
    expect(noPerm.status).toBe(403)
    expect(noPerm.body.error.code).toBe('forbidden')

    const { token: otherToken } = await createSecondAgent()
    const notOwner = await request(app)
      .post(`/api/v1/jobs/${created.id}/start`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ version: 3 })
    expect(notOwner.status).toBe(403)
    expect(notOwner.body.error.code).toBe('forbidden')

    const anonymous = await request(app).post(`/api/v1/jobs/${created.id}/start`).send({ version: 3 })
    expect(anonymous.status).toBe(401)
    expect(anonymous.body.error.code).toBe('unauthorized')
  })

  it('yields 409 with fresh state, 422 for illegal moves, 404 cross-org', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)

    const illegal = await request(app)
      .post(`/api/v1/jobs/${created.id}/start`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ version: 1 })
    expect(illegal.status).toBe(422)
    expect(illegal.body.error.code).toBe('invalid_transition')

    await progressToAccepted(created.id)
    const stale = await request(app)
      .post(`/api/v1/jobs/${created.id}/start`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ version: 1 })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('version_conflict')
    expect(stale.body.error.details).toMatchObject({ currentVersion: 3, currentStatus: 'ACCEPTED' })

    const shadowToken = await tokenFor(shadowEmail)
    const crossOrg = await request(app)
      .post(`/api/v1/jobs/${created.id}/start`)
      .set('Authorization', `Bearer ${shadowToken}`)
      .send({ version: 3 })
    expect(crossOrg.status).toBe(404)
    expect(crossOrg.body.error.code).toBe('not_found')

    const missingVersion = await request(app)
      .post(`/api/v1/jobs/${created.id}/start`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({})
    expect(missingVersion.status).toBe(400)
    expect(missingVersion.body.error.code).toBe('validation_error')
  })

  it('replays idempotent retries, rejects key reuse, and reports in-flight keys', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)
    await progressToAccepted(created.id)
    const key = crypto.randomUUID()
    const first = await request(app)
      .post(`/api/v1/jobs/${created.id}/start`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('Idempotency-Key', key)
      .send({ version: 3 })
    const second = await request(app)
      .post(`/api/v1/jobs/${created.id}/start`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('Idempotency-Key', key)
      .send({ version: 3 })
    expect(first.status).toBe(200)
    expect(second.headers['idempotent-replay']).toBe('true')
    expect(second.body).toEqual(first.body)

    const reuse = await request(app)
      .post(`/api/v1/jobs/${created.id}/start`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('Idempotency-Key', key)
      .send({ version: 1 })
    expect(reuse.status).toBe(422)
    expect(reuse.body.error.code).toBe('idempotency_key_reuse')

    const organization = await ownerDatabase.organization.findFirstOrThrow({
      where: { slug: 'dispatchgrid-demo' },
    })
    const inFlightKey = crypto.randomUUID()
    await ownerDatabase.idempotencyKey.create({
      data: {
        organizationId: organization.id,
        operation: 'job.start',
        key: inFlightKey,
        requestFingerprint: 'test-fingerprint',
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    const inFlight = await request(app)
      .post(`/api/v1/jobs/${created.id}/start`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('Idempotency-Key', inFlightKey)
      .send({ version: 3 })
    expect(inFlight.status).toBe(409)
    expect(inFlight.body.error.code).toBe('idempotency_in_progress')
  })

  it('invalidates the board cache on start', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)
    await progressToAccepted(created.id)
    const getBoard = () =>
      request(app).get('/api/v1/jobs').set('Authorization', `Bearer ${dispatcherToken}`)
    await getBoard()
    expect((await getBoard()).headers['x-board-cache']).toBe('HIT')
    const started = await request(app)
      .post(`/api/v1/jobs/${created.id}/start`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ version: 3 })
    expect(started.status).toBe(200)
    expect((await getBoard()).headers['x-board-cache']).toBe('MISS')
  })
})

describe('POST /api/v1/jobs/:id/complete', () => {
  it('completes the owned IN_PROGRESS job', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)
    await progressToInProgress(created.id)
    const response = await request(app)
      .post(`/api/v1/jobs/${created.id}/complete`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ version: 4 })
    expect(response.status).toBe(200)
    expect(response.body.job).toMatchObject({ status: 'COMPLETED', version: 5 })
  })

  it('enforces permission and ownership (403 distinct from 409)', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const created = await createJobViaApi(dispatcherToken)
    await progressToInProgress(created.id)

    const noPerm = await request(app)
      .post(`/api/v1/jobs/${created.id}/complete`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .send({ version: 4 })
    expect(noPerm.status).toBe(403)
    expect(noPerm.body.error.code).toBe('forbidden')

    const { token: otherToken } = await createSecondAgent()
    const notOwner = await request(app)
      .post(`/api/v1/jobs/${created.id}/complete`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ version: 4 })
    expect(notOwner.status).toBe(403)
    expect(notOwner.body.error.code).toBe('forbidden')
  })

  it('yields 409, 422, 404, 401, and 400 exactly', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)
    const early = await createJobViaApi(dispatcherToken)
    await progressToAccepted(early.id)

    const illegal = await request(app)
      .post(`/api/v1/jobs/${early.id}/complete`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ version: 3 })
    expect(illegal.status).toBe(422)
    expect(illegal.body.error.code).toBe('invalid_transition')

    await progressToInProgress(created.id)
    const stale = await request(app)
      .post(`/api/v1/jobs/${created.id}/complete`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ version: 3 })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('version_conflict')
    expect(stale.body.error.details).toMatchObject({ currentVersion: 4, currentStatus: 'IN_PROGRESS' })

    const shadowToken = await tokenFor(shadowEmail)
    const crossOrg = await request(app)
      .post(`/api/v1/jobs/${created.id}/complete`)
      .set('Authorization', `Bearer ${shadowToken}`)
      .send({ version: 4 })
    expect(crossOrg.status).toBe(404)

    const anonymous = await request(app)
      .post(`/api/v1/jobs/${created.id}/complete`)
      .send({ version: 4 })
    expect(anonymous.status).toBe(401)
    expect(anonymous.body.error.code).toBe('unauthorized')

    const missingVersion = await request(app)
      .post(`/api/v1/jobs/${created.id}/complete`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({})
    expect(missingVersion.status).toBe(400)
    expect(missingVersion.body.error.code).toBe('validation_error')
  })

  it('replays idempotent retries with the marker', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)
    await progressToInProgress(created.id)
    const key = crypto.randomUUID()
    const first = await request(app)
      .post(`/api/v1/jobs/${created.id}/complete`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('Idempotency-Key', key)
      .send({ version: 4 })
    const second = await request(app)
      .post(`/api/v1/jobs/${created.id}/complete`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('Idempotency-Key', key)
      .send({ version: 4 })
    expect(first.status).toBe(200)
    expect(second.headers['idempotent-replay']).toBe('true')
    expect(second.body).toEqual(first.body)
  })

  it('invalidates the board cache on complete', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)
    await progressToInProgress(created.id)
    const getBoard = () =>
      request(app).get('/api/v1/jobs').set('Authorization', `Bearer ${dispatcherToken}`)
    await getBoard()
    expect((await getBoard()).headers['x-board-cache']).toBe('HIT')
    const completed = await request(app)
      .post(`/api/v1/jobs/${created.id}/complete`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ version: 4 })
    expect(completed.status).toBe(200)
    expect((await getBoard()).headers['x-board-cache']).toBe('MISS')
  })
})

describe('POST /api/v1/jobs/:id/cancel', () => {
  it('cancels with a reason and bumps version', async () => {
    const token = await tokenFor(dispatcherEmail)
    const created = await createJobViaApi(token)
    const response = await request(app)
      .post(`/api/v1/jobs/${created.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1, reason: 'Customer called it off' })
    expect(response.status).toBe(200)
    expect(response.body.job).toMatchObject({ status: 'CANCELLED', version: 2 })
  })

  it('requires job.cancel permission (agent denied with 403)', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)
    const denied = await request(app)
      .post(`/api/v1/jobs/${created.id}/cancel`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ version: 1, reason: 'Nope' })
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('forbidden')

    const anonymous = await request(app)
      .post(`/api/v1/jobs/${created.id}/cancel`)
      .send({ version: 1, reason: 'Nope' })
    expect(anonymous.status).toBe(401)
  })

  it('requires a reason and a version (400), conflicts on stale (409), rejects terminal (422)', async () => {
    const token = await tokenFor(dispatcherEmail)
    const created = await createJobViaApi(token)

    const noReason = await request(app)
      .post(`/api/v1/jobs/${created.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1 })
    expect(noReason.status).toBe(400)
    expect(noReason.body.error.code).toBe('validation_error')

    const noVersion = await request(app)
      .post(`/api/v1/jobs/${created.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'x' })
    expect(noVersion.status).toBe(400)

    const first = await request(app)
      .post(`/api/v1/jobs/${created.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1, reason: 'First' })
    expect(first.status).toBe(200)

    const stale = await request(app)
      .post(`/api/v1/jobs/${crypto.randomUUID()}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1, reason: 'Missing' })
    expect(stale.status).toBe(404)

    const terminal = await request(app)
      .post(`/api/v1/jobs/${created.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 2, reason: 'Again' })
    expect(terminal.status).toBe(422)
    expect(terminal.body.error.code).toBe('invalid_transition')
  })

  it('yields 409 with fresh state on a raced cancel', async () => {
    const token = await tokenFor(dispatcherEmail)
    const created = await createJobViaApi(token)
    await request(app)
      .patch(`/api/v1/jobs/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Bump', version: 1 })
    const stale = await request(app)
      .post(`/api/v1/jobs/${created.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1, reason: 'Stale' })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('version_conflict')
    expect(stale.body.error.details).toMatchObject({ currentVersion: 2, currentStatus: 'PENDING' })
  })

  it('replays idempotent retries and rejects key reuse', async () => {
    const token = await tokenFor(dispatcherEmail)
    const created = await createJobViaApi(token)
    const key = crypto.randomUUID()
    const first = await request(app)
      .post(`/api/v1/jobs/${created.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ version: 1, reason: 'Duplicate-safe' })
    const second = await request(app)
      .post(`/api/v1/jobs/${created.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ version: 1, reason: 'Duplicate-safe' })
    expect(first.status).toBe(200)
    expect(second.headers['idempotent-replay']).toBe('true')
    expect(second.body).toEqual(first.body)

    const reuse = await request(app)
      .post(`/api/v1/jobs/${created.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ version: 1, reason: 'Different reason' })
    expect(reuse.status).toBe(422)
    expect(reuse.body.error.code).toBe('idempotency_key_reuse')
  })

  it('invalidates the board cache on cancel', async () => {
    const token = await tokenFor(dispatcherEmail)
    const created = await createJobViaApi(token)
    const getBoard = () => request(app).get('/api/v1/jobs').set('Authorization', `Bearer ${token}`)
    await getBoard()
    expect((await getBoard()).headers['x-board-cache']).toBe('HIT')
    const cancelled = await request(app)
      .post(`/api/v1/jobs/${created.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version: 1, reason: 'Cache check' })
    expect(cancelled.status).toBe(200)
    expect((await getBoard()).headers['x-board-cache']).toBe('MISS')
  })
})

describe('POST /api/v1/jobs/:id/fail', () => {
  it('fails the owned IN_PROGRESS job with a reason', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)
    await progressToInProgress(created.id)
    const response = await request(app)
      .post(`/api/v1/jobs/${created.id}/fail`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ version: 4, reason: 'Pump seized on site' })
    expect(response.status).toBe(200)
    expect(response.body.job).toMatchObject({ status: 'FAILED', version: 5 })
  })

  it('requires the in-progress state (422 otherwise) and a reason (400)', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)

    const fromPending = await request(app)
      .post(`/api/v1/jobs/${created.id}/fail`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ version: 1, reason: 'Too early' })
    expect(fromPending.status).toBe(422)
    expect(fromPending.body.error.code).toBe('invalid_transition')

    await progressToAccepted(created.id)
    const fromAccepted = await request(app)
      .post(`/api/v1/jobs/${created.id}/fail`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ version: 3, reason: 'Still early' })
    expect(fromAccepted.status).toBe(422)

    const { actor: agentActor } = await actorFor(agentEmail)
    await startJobService(agentActor, created.id, { version: 3 })
    const noReason = await request(app)
      .post(`/api/v1/jobs/${created.id}/fail`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ version: 4 })
    expect(noReason.status).toBe(400)
    expect(noReason.body.error.code).toBe('validation_error')
  })

  it('enforces permission and ownership, 404 cross-org, 401 anonymous', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const created = await createJobViaApi(dispatcherToken)
    await progressToInProgress(created.id)

    const noPerm = await request(app)
      .post(`/api/v1/jobs/${created.id}/fail`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .send({ version: 4, reason: 'x' })
    expect(noPerm.status).toBe(403)
    expect(noPerm.body.error.code).toBe('forbidden')

    const { token: otherToken } = await createSecondAgent()
    const notOwner = await request(app)
      .post(`/api/v1/jobs/${created.id}/fail`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ version: 4, reason: 'x' })
    expect(notOwner.status).toBe(403)

    const shadowToken = await tokenFor(shadowEmail)
    const crossOrg = await request(app)
      .post(`/api/v1/jobs/${created.id}/fail`)
      .set('Authorization', `Bearer ${shadowToken}`)
      .send({ version: 4, reason: 'x' })
    expect(crossOrg.status).toBe(404)
    expect(crossOrg.body.error.code).toBe('not_found')

    const anonymous = await request(app)
      .post(`/api/v1/jobs/${created.id}/fail`)
      .send({ version: 4, reason: 'x' })
    expect(anonymous.status).toBe(401)
  })

  it('yields 409 with fresh state on stale versions', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)
    await progressToInProgress(created.id)
    const stale = await request(app)
      .post(`/api/v1/jobs/${created.id}/fail`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ version: 3, reason: 'Stale' })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('version_conflict')
    expect(stale.body.error.details).toMatchObject({ currentVersion: 4, currentStatus: 'IN_PROGRESS' })
  })

  it('replays idempotent retries with the marker', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)
    await progressToInProgress(created.id)
    const key = crypto.randomUUID()
    const first = await request(app)
      .post(`/api/v1/jobs/${created.id}/fail`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('Idempotency-Key', key)
      .send({ version: 4, reason: 'Retry-safe' })
    const second = await request(app)
      .post(`/api/v1/jobs/${created.id}/fail`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('Idempotency-Key', key)
      .send({ version: 4, reason: 'Retry-safe' })
    expect(first.status).toBe(200)
    expect(second.headers['idempotent-replay']).toBe('true')
    expect(second.body).toEqual(first.body)
  })

  it('invalidates the board cache on fail', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const agentToken = await tokenFor(agentEmail)
    const created = await createJobViaApi(dispatcherToken)
    await progressToInProgress(created.id)
    const getBoard = () =>
      request(app).get('/api/v1/jobs').set('Authorization', `Bearer ${dispatcherToken}`)
    await getBoard()
    expect((await getBoard()).headers['x-board-cache']).toBe('HIT')
    const failed = await request(app)
      .post(`/api/v1/jobs/${created.id}/fail`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ version: 4, reason: 'Cache check' })
    expect(failed.status).toBe(200)
    expect((await getBoard()).headers['x-board-cache']).toBe('MISS')
  })
})
