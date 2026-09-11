import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { seedDatabase } from '../../../prisma/seed.js'
import { app } from '../../app.js'
import { prisma } from '../../db/client.js'
import { signAccessToken } from '../../auth/tokens.js'
import { clearBoardCache } from '../../routes/jobs.js'
import {
  createOrganizationFixture,
  createOwnerTestClient,
  createRoleFixture,
  createUserFixture,
  resetDatabase,
} from '../helpers.js'

// B10-T3 (#22): assignment + suggestions route contract over HTTP against
// real Postgres. Uses the B09 services through the jobs router only; every
// documented status/code below is asserted at the HTTP seam.
//
// Isolation: each test builds a private organization (dispatcher + agent +
// role permissions) and asserts tenant-scoped state only, so parallel runners
// sharing the dev database cannot leak into counts, boards, or rankings.

const ownerDatabase = createOwnerTestClient()

beforeEach(async () => {
  clearBoardCache()
  await resetDatabase(ownerDatabase)
  await seedDatabase(ownerDatabase)
})

afterAll(async () => {
  await Promise.all([ownerDatabase.$disconnect(), prisma.$disconnect()])
})

async function setupAssignmentOrg() {
  const organization = await createOrganizationFixture(ownerDatabase)
  await ownerDatabase.counter.create({
    data: { organizationId: organization.id, name: 'job-reference' },
  })
  const dispatcherRole = await createRoleFixture(ownerDatabase, organization.id, {
    name: `DISPATCHER_${crypto.randomUUID().slice(0, 8)}`,
  })
  const agentRole = await createRoleFixture(ownerDatabase, organization.id, {
    name: 'AGENT',
  })
  const permissions = await ownerDatabase.permission.findMany({
    where: { code: { in: ['job.view', 'job.create', 'job.assign', 'job.respond'] } },
  })
  const permissionId = new Map(permissions.map((entry) => [entry.code, entry.id]))
  for (const code of ['job.view', 'job.create', 'job.assign']) {
    await ownerDatabase.rolePermission.create({
      data: {
        organizationId: organization.id,
        roleId: dispatcherRole.id,
        permissionId: permissionId.get(code),
      },
    })
  }
  for (const code of ['job.view', 'job.respond']) {
    await ownerDatabase.rolePermission.create({
      data: {
        organizationId: organization.id,
        roleId: agentRole.id,
        permissionId: permissionId.get(code),
      },
    })
  }
  const dispatcher = await createUserFixture(ownerDatabase)
  await ownerDatabase.membership.create({
    data: {
      organizationId: organization.id,
      userId: dispatcher.id,
      roleId: dispatcherRole.id,
      isAvailable: false,
    },
  })
  const agent = await createUserFixture(ownerDatabase)
  await ownerDatabase.membership.create({
    data: {
      organizationId: organization.id,
      userId: agent.id,
      roleId: agentRole.id,
      isAvailable: true,
    },
  })
  return {
    organization,
    agentRole,
    dispatcher,
    agent,
    dispatcherToken: signAccessToken(dispatcher.id),
    agentToken: signAccessToken(agent.id),
  }
}

async function createExtraAgent(organization, agentRole, tag) {
  const user = await createUserFixture(ownerDatabase, {
    email: `assign-${tag}-${crypto.randomUUID()}@example.test`,
  })
  await ownerDatabase.membership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      roleId: agentRole.id,
      isAvailable: true,
    },
  })
  return user
}

function jobPayload(overrides = {}) {
  return {
    title: 'Fix basement pump',
    description: 'Standing water near unit 3',
    address: '1 Main St',
    latitude: 51.5,
    longitude: -0.12,
    priority: 'HIGH',
    dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  }
}

async function createJobViaHttp(token, key = crypto.randomUUID()) {
  const response = await request(app)
    .post('/api/v1/jobs')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send(jobPayload())
  expect(response.status).toBe(201)
  return response.body.job
}

async function addActiveAssignment(organizationId, createdById, agentId, tag) {
  const job = await ownerDatabase.job.create({
    data: {
      organizationId,
      reference: `T22-${tag}-${crypto.randomUUID().slice(0, 8)}`,
      title: `Active job ${tag}`,
      latitude: 51.5,
      longitude: -0.12,
      status: 'ASSIGNED',
      currentAssigneeId: agentId,
      createdById,
      version: 2,
      dueAt: new Date(Date.now() + 3_600_000),
    },
  })
  await ownerDatabase.assignment.create({
    data: {
      organizationId,
      jobId: job.id,
      agentId,
      state: 'ACCEPTED',
    },
  })
  return job
}

describe('POST /api/v1/jobs/:id/assign', () => {
  it('offers a pending job to an eligible agent with 200 and serialized bodies', async () => {
    const org = await setupAssignmentOrg()
    const job = await createJobViaHttp(org.dispatcherToken)

    const response = await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: org.agent.id, version: 1 })

    expect(response.status).toBe(200)
    expect(response.headers['idempotent-replay']).toBeUndefined()
    expect(response.body.job).toMatchObject({
      id: job.id,
      status: 'ASSIGNED',
      version: 2,
      currentAssigneeId: org.agent.id,
    })
    expect(response.body.assignment).toMatchObject({
      jobId: job.id,
      agentId: org.agent.id,
      state: 'OFFERED',
    })
    expect(typeof response.body.assignment.id).toBe('string')
  })

  it('requires the assign permission', async () => {
    const org = await setupAssignmentOrg()
    const job = await createJobViaHttp(org.dispatcherToken)

    const response = await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${org.agentToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: org.agent.id, version: 1 })

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('forbidden')
  })

  it('requires a mandatory version and agent with strict parsing', async () => {
    const org = await setupAssignmentOrg()
    const job = await createJobViaHttp(org.dispatcherToken)
    const post = (body) =>
      request(app)
        .post(`/api/v1/jobs/${job.id}/assign`)
        .set('Authorization', `Bearer ${org.dispatcherToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send(body)

    const missingVersion = await post({ agentId: org.agent.id })
    expect(missingVersion.status).toBe(400)
    expect(missingVersion.body.error.code).toBe('validation_error')

    const missingAgent = await post({ version: 1 })
    expect(missingAgent.status).toBe(400)
    expect(missingAgent.body.error.code).toBe('validation_error')

    const malformed = await request(app)
      .post('/api/v1/jobs/not-a-uuid/assign')
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
      .send({ agentId: org.agent.id, version: 1 })
    expect(malformed.status).toBe(400)
    expect(malformed.body.error.code).toBe('validation_error')
  })

  it('carries fresh state on a stale-version conflict', async () => {
    const org = await setupAssignmentOrg()
    const job = await createJobViaHttp(org.dispatcherToken)

    const first = await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: org.agent.id, version: 1 })
    expect(first.status).toBe(200)

    const stale = await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: org.agent.id, version: 1 })

    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('version_conflict')
    expect(stale.body.error.details).toMatchObject({
      currentVersion: 2,
      currentStatus: 'ASSIGNED',
    })
  })

  it('rejects ineligible agents without moving the job', async () => {
    const org = await setupAssignmentOrg()
    const job = await createJobViaHttp(org.dispatcherToken)

    const response = await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: org.dispatcher.id, version: 1 })

    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe('agent_not_eligible')
    expect(response.body.error.details.reasons).toContain('wrong_role')

    const fresh = await request(app)
      .get(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
    expect(fresh.body.job.status).toBe('PENDING')
    expect(fresh.body.job.version).toBe(1)
  })

  it('replays the identical response for the same key without duplicating', async () => {
    const org = await setupAssignmentOrg()
    const job = await createJobViaHttp(org.dispatcherToken)
    const key = crypto.randomUUID()
    const send = () =>
      request(app)
        .post(`/api/v1/jobs/${job.id}/assign`)
        .set('Authorization', `Bearer ${org.dispatcherToken}`)
        .set('Idempotency-Key', key)
        .send({ agentId: org.agent.id, version: 1 })

    const first = await send()
    const second = await send()

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.headers['idempotent-replay']).toBe('true')
    expect(second.body).toEqual(first.body)
    expect(
      await ownerDatabase.assignment.count({ where: { jobId: job.id } }),
    ).toBe(1)
    expect(
      await ownerDatabase.jobEvent.count({
        where: { jobId: job.id, toStatus: 'ASSIGNED' },
      }),
    ).toBe(1)
  })

  it('rejects the same key with a different body', async () => {
    const org = await setupAssignmentOrg()
    const other = await createExtraAgent(org.organization, org.agentRole, 'key-reuse')
    const job = await createJobViaHttp(org.dispatcherToken)
    const key = crypto.randomUUID()

    const first = await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
      .set('Idempotency-Key', key)
      .send({ agentId: org.agent.id, version: 1 })
    const second = await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
      .set('Idempotency-Key', key)
      .send({ agentId: other.id, version: 1 })

    expect(first.status).toBe(200)
    expect(second.status).toBe(422)
    expect(second.body.error.code).toBe('idempotency_key_reuse')
  })

  it('returns 404 for cross-organization job writes, never 403', async () => {
    const orgA = await setupAssignmentOrg()
    const orgB = await setupAssignmentOrg()
    const job = await createJobViaHttp(orgA.dispatcherToken)

    const response = await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${orgB.dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: orgB.agent.id, version: 1 })

    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('not_found')
  })
})

describe('POST /api/v1/jobs/:id/accept and /decline', () => {
  it('completes the full offer-to-accept lifecycle through HTTP alone', async () => {
    const org = await setupAssignmentOrg()

    const job = await createJobViaHttp(org.dispatcherToken)
    expect(job.status).toBe('PENDING')
    expect(job.version).toBe(1)

    const offered = await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: org.agent.id, version: 1 })
    expect(offered.status).toBe(200)
    expect(offered.body.job.status).toBe('ASSIGNED')
    expect(offered.body.job.version).toBe(2)
    expect(offered.body.job.currentAssigneeId).toBe(org.agent.id)
    expect(offered.body.assignment.state).toBe('OFFERED')

    const accepted = await request(app)
      .post(`/api/v1/jobs/${job.id}/accept`)
      .set('Authorization', `Bearer ${org.agentToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ version: 2 })
    expect(accepted.status).toBe(200)
    expect(accepted.body.job).toMatchObject({
      id: job.id,
      status: 'ACCEPTED',
      version: 3,
      currentAssigneeId: org.agent.id,
    })
    expect(accepted.body.assignment).toMatchObject({
      jobId: job.id,
      agentId: org.agent.id,
      state: 'ACCEPTED',
    })

    const detail = await request(app)
      .get(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
    expect(detail.body.job.status).toBe('ACCEPTED')
    expect(detail.body.job.version).toBe(3)
  })

  it('declines the owned offer back to pending and clears the assignee', async () => {
    const org = await setupAssignmentOrg()
    const job = await createJobViaHttp(org.dispatcherToken)

    await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: org.agent.id, version: 1 })

    const declined = await request(app)
      .post(`/api/v1/jobs/${job.id}/decline`)
      .set('Authorization', `Bearer ${org.agentToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ version: 2 })

    expect(declined.status).toBe(200)
    expect(declined.body.job).toMatchObject({
      id: job.id,
      status: 'PENDING',
      version: 3,
      currentAssigneeId: null,
    })
    expect(declined.body.assignment).toMatchObject({
      jobId: job.id,
      agentId: org.agent.id,
      state: 'DECLINED',
    })
  })

  it('rejects another agent accepting with 409 and fresh state', async () => {
    const org = await setupAssignmentOrg()
    const rival = await createExtraAgent(org.organization, org.agentRole, 'rival-accept')
    const rivalToken = signAccessToken(rival.id)
    const job = await createJobViaHttp(org.dispatcherToken)

    await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: org.agent.id, version: 1 })

    const response = await request(app)
      .post(`/api/v1/jobs/${job.id}/accept`)
      .set('Authorization', `Bearer ${rivalToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ version: 2 })

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('version_conflict')
    expect(response.body.error.details).toMatchObject({
      currentVersion: 2,
      currentStatus: 'ASSIGNED',
    })

    const fresh = await request(app)
      .get(`/api/v1/jobs/${job.id}`)
      .set('Authorization', `Bearer ${org.agentToken}`)
    expect(fresh.body.job.status).toBe('ASSIGNED')
    expect(fresh.body.job.currentAssigneeId).toBe(org.agent.id)
  })

  it('rejects another agent declining with 409', async () => {
    const org = await setupAssignmentOrg()
    const rival = await createExtraAgent(org.organization, org.agentRole, 'rival-decline')
    const rivalToken = signAccessToken(rival.id)
    const job = await createJobViaHttp(org.dispatcherToken)

    await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: org.agent.id, version: 1 })

    const response = await request(app)
      .post(`/api/v1/jobs/${job.id}/decline`)
      .set('Authorization', `Bearer ${rivalToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ version: 2 })

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('version_conflict')
  })

  it('rejects accepting twice as an invalid transition', async () => {
    const org = await setupAssignmentOrg()
    const job = await createJobViaHttp(org.dispatcherToken)

    await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: org.agent.id, version: 1 })
    const accepted = await request(app)
      .post(`/api/v1/jobs/${job.id}/accept`)
      .set('Authorization', `Bearer ${org.agentToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ version: 2 })
    expect(accepted.status).toBe(200)

    const second = await request(app)
      .post(`/api/v1/jobs/${job.id}/accept`)
      .set('Authorization', `Bearer ${org.agentToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ version: 3 })

    expect(second.status).toBe(422)
    expect(second.body.error.code).toBe('invalid_transition')
  })

  it('carries fresh state on a stale-version accept', async () => {
    const org = await setupAssignmentOrg()
    const job = await createJobViaHttp(org.dispatcherToken)

    await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: org.agent.id, version: 1 })

    const stale = await request(app)
      .post(`/api/v1/jobs/${job.id}/accept`)
      .set('Authorization', `Bearer ${org.agentToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ version: 1 })

    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('version_conflict')
    expect(stale.body.error.details).toMatchObject({
      currentVersion: 2,
      currentStatus: 'ASSIGNED',
    })
  })

  it('enforces the respond permission and a mandatory version', async () => {
    const org = await setupAssignmentOrg()
    const job = await createJobViaHttp(org.dispatcherToken)

    await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: org.agent.id, version: 1 })

    const forbiddenResponse = await request(app)
      .post(`/api/v1/jobs/${job.id}/accept`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ version: 2 })
    expect(forbiddenResponse.status).toBe(403)
    expect(forbiddenResponse.body.error.code).toBe('forbidden')

    const missingVersion = await request(app)
      .post(`/api/v1/jobs/${job.id}/accept`)
      .set('Authorization', `Bearer ${org.agentToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({})
    expect(missingVersion.status).toBe(400)
    expect(missingVersion.body.error.code).toBe('validation_error')
  })

  it('returns 404 for cross-organization accept writes', async () => {
    const orgA = await setupAssignmentOrg()
    const orgB = await setupAssignmentOrg()
    const job = await createJobViaHttp(orgA.dispatcherToken)

    await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${orgA.dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: orgA.agent.id, version: 1 })

    const response = await request(app)
      .post(`/api/v1/jobs/${job.id}/accept`)
      .set('Authorization', `Bearer ${orgB.agentToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ version: 2 })

    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('not_found')
  })

  it('replays the identical accept for the same key without duplicating', async () => {
    const org = await setupAssignmentOrg()
    const job = await createJobViaHttp(org.dispatcherToken)

    await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: org.agent.id, version: 1 })

    const key = crypto.randomUUID()
    const send = () =>
      request(app)
        .post(`/api/v1/jobs/${job.id}/accept`)
        .set('Authorization', `Bearer ${org.agentToken}`)
        .set('Idempotency-Key', key)
        .send({ version: 2 })

    const first = await send()
    const second = await send()

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.headers['idempotent-replay']).toBe('true')
    expect(second.body).toEqual(first.body)
    expect(
      await ownerDatabase.jobEvent.count({
        where: { jobId: job.id, toStatus: 'ACCEPTED' },
      }),
    ).toBe(1)
  })

  it('replays the identical decline for the same key without duplicating', async () => {
    const org = await setupAssignmentOrg()
    const job = await createJobViaHttp(org.dispatcherToken)

    await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: org.agent.id, version: 1 })

    const key = crypto.randomUUID()
    const send = () =>
      request(app)
        .post(`/api/v1/jobs/${job.id}/decline`)
        .set('Authorization', `Bearer ${org.agentToken}`)
        .set('Idempotency-Key', key)
        .send({ version: 2 })

    const first = await send()
    const second = await send()

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.headers['idempotent-replay']).toBe('true')
    expect(second.body).toEqual(first.body)
    expect(
      await ownerDatabase.jobEvent.count({
        where: { jobId: job.id, fromStatus: 'ASSIGNED', toStatus: 'PENDING' },
      }),
    ).toBe(1)
  })

  it('returns 404 for cross-organization decline writes', async () => {
    const orgA = await setupAssignmentOrg()
    const orgB = await setupAssignmentOrg()
    const job = await createJobViaHttp(orgA.dispatcherToken)

    await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${orgA.dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: orgA.agent.id, version: 1 })

    const response = await request(app)
      .post(`/api/v1/jobs/${job.id}/decline`)
      .set('Authorization', `Bearer ${orgB.agentToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ version: 2 })

    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('not_found')
  })
})

describe('GET /api/v1/jobs/:id/suggestions', () => {
  it('returns ranked eligible agents with component scores, deterministically', async () => {
    const org = await setupAssignmentOrg()
    const job = await createJobViaHttp(org.dispatcherToken)

    const first = await request(app)
      .get(`/api/v1/jobs/${job.id}/suggestions`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
    expect(first.status).toBe(200)
    expect(Array.isArray(first.body.suggestions)).toBe(true)

    const agentEntry = first.body.suggestions.find(
      (entry) => entry.userId === org.agent.id,
    )
    expect(agentEntry).toMatchObject({
      userId: org.agent.id,
      agentId: org.agent.id,
      activeJobs: 0,
      positionKnown: false,
    })
    expect(Object.keys(agentEntry).sort()).toEqual(
      ['activeJobs', 'agentId', 'distanceKm', 'finalScore', 'positionKnown', 'userId'].sort(),
    )
    expect(agentEntry.distanceKm).toBeNull()
    expect(agentEntry.finalScore).toBeNull()

    const second = await request(app)
      .get(`/api/v1/jobs/${job.id}/suggestions`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
    expect(second.body).toEqual(first.body)
  })

  it('orders unknown positions by load before user id', async () => {
    const org = await setupAssignmentOrg()
    const busy = await createExtraAgent(org.organization, org.agentRole, 'busy-suggest')
    await addActiveAssignment(
      org.organization.id,
      org.dispatcher.id,
      busy.id,
      'busy',
    )
    const job = await createJobViaHttp(org.dispatcherToken)

    const response = await request(app)
      .get(`/api/v1/jobs/${job.id}/suggestions`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)

    expect(response.status).toBe(200)
    const relevant = response.body.suggestions.filter((entry) =>
      [org.agent.id, busy.id].includes(entry.userId),
    )
    expect(relevant.map((entry) => entry.userId)).toEqual([org.agent.id, busy.id])
    expect(relevant.map((entry) => entry.activeJobs)).toEqual([0, 1])
    for (const entry of relevant) {
      expect(entry.positionKnown).toBe(false)
    }
  })

  it('performs no writes', async () => {
    const org = await setupAssignmentOrg()
    await createExtraAgent(org.organization, org.agentRole, 'nowrite-suggest')
    const job = await createJobViaHttp(org.dispatcherToken)
    const counts = () =>
      Promise.all([
        ownerDatabase.job.count({ where: { organizationId: org.organization.id } }),
        ownerDatabase.assignment.count({
          where: { organizationId: org.organization.id },
        }),
        ownerDatabase.jobEvent.count({
          where: { organizationId: org.organization.id },
        }),
      ])

    const before = await counts()
    await request(app)
      .get(`/api/v1/jobs/${job.id}/suggestions`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
    await request(app)
      .get(`/api/v1/jobs/${job.id}/suggestions`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
    const after = await counts()

    expect(after).toEqual(before)
  })

  it('succeeds with an empty list when nobody is eligible', async () => {
    const org = await setupAssignmentOrg()
    await ownerDatabase.membership.updateMany({
      where: { userId: org.agent.id },
      data: { isAvailable: false },
    })
    const job = await createJobViaHttp(org.dispatcherToken)

    const response = await request(app)
      .get(`/api/v1/jobs/${job.id}/suggestions`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)

    expect(response.status).toBe(200)
    expect(response.body.suggestions).toEqual([])
  })

  it('returns 404 for cross-organization suggestion reads', async () => {
    const orgA = await setupAssignmentOrg()
    const orgB = await setupAssignmentOrg()
    const job = await createJobViaHttp(orgA.dispatcherToken)

    const response = await request(app)
      .get(`/api/v1/jobs/${job.id}/suggestions`)
      .set('Authorization', `Bearer ${orgB.dispatcherToken}`)

    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('not_found')
  })

  it('requires the assign permission and rejects malformed ids', async () => {
    const org = await setupAssignmentOrg()
    const job = await createJobViaHttp(org.dispatcherToken)

    const forbiddenResponse = await request(app)
      .get(`/api/v1/jobs/${job.id}/suggestions`)
      .set('Authorization', `Bearer ${org.agentToken}`)
    expect(forbiddenResponse.status).toBe(403)
    expect(forbiddenResponse.body.error.code).toBe('forbidden')

    const malformed = await request(app)
      .get('/api/v1/jobs/not-a-uuid/suggestions')
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
    expect(malformed.status).toBe(400)
    expect(malformed.body.error.code).toBe('validation_error')
  })
})

describe('board cache invalidation on assignment writes', () => {
  it('misses the board again after assign and accept with fresh state', async () => {
    const org = await setupAssignmentOrg()
    const job = await createJobViaHttp(org.dispatcherToken)
    const getBoard = () =>
      request(app).get('/api/v1/jobs').set('Authorization', `Bearer ${org.dispatcherToken}`)

    const miss = await getBoard()
    expect(miss.headers['x-board-cache']).toBe('MISS')
    expect(miss.body.total).toBe(1)

    const hit = await getBoard()
    expect(hit.headers['x-board-cache']).toBe('HIT')

    const offered = await request(app)
      .post(`/api/v1/jobs/${job.id}/assign`)
      .set('Authorization', `Bearer ${org.dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: org.agent.id, version: 1 })
    expect(offered.status).toBe(200)

    const afterAssign = await getBoard()
    expect(afterAssign.headers['x-board-cache']).toBe('MISS')
    expect(afterAssign.body.jobs.find((entry) => entry.id === job.id).status).toBe(
      'ASSIGNED',
    )

    const accepted = await request(app)
      .post(`/api/v1/jobs/${job.id}/accept`)
      .set('Authorization', `Bearer ${org.agentToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ version: 2 })
    expect(accepted.status).toBe(200)

    const afterAccept = await getBoard()
    expect(afterAccept.headers['x-board-cache']).toBe('MISS')
    expect(afterAccept.body.jobs.find((entry) => entry.id === job.id).status).toBe(
      'ACCEPTED',
    )
  })
})
