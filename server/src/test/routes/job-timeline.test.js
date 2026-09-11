import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { seedDatabase } from '../../../prisma/seed.js'
import { app } from '../../app.js'
import { prisma } from '../../db/client.js'
import { signAccessToken } from '../../auth/tokens.js'
import { clearBoardCache } from '../../routes/jobs.js'
import { integrationAdapters } from '../../lib/integration-adapters.js'
import {
  createOwnerTestClient,
  createRoleFixture,
  createUserFixture,
  resetDatabase,
} from '../helpers.js'

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

async function userIdFor(email) {
  const user = await ownerDatabase.user.findUniqueOrThrow({ where: { email } })
  return user.id
}

async function demoOrg() {
  return ownerDatabase.organization.findFirstOrThrow({
    where: { slug: 'dispatchgrid-demo' },
  })
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

async function createNoPermToken() {
  const organization = await demoOrg()
  const user = await createUserFixture(ownerDatabase)
  const role = await createRoleFixture(ownerDatabase, organization.id)
  await ownerDatabase.membership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      roleId: role.id,
    },
  })
  return signAccessToken(user.id)
}

// Audit writes are best-effort on res finish — poll briefly instead of sleeping blindly.
async function waitForAudit(where, timeoutMs = 3000) {
  const start = Date.now()
  for (;;) {
    const row = await ownerDatabase.auditLog.findFirst({ where })
    if (row) return row
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for audit log row')
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('GET /api/v1/jobs/:id/events', () => {
  it('returns the ordered durable history with actor, transition, reason, and time', async () => {
    const token = await tokenFor(dispatcherEmail)
    const dispatcherId = await userIdFor(dispatcherEmail)
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(jobPayload())
    expect(created.status).toBe(201)
    const jobId = created.body.job.id

    // Second event with a later timestamp proves ordering is by time.
    const organization = await demoOrg()
    await ownerDatabase.jobEvent.create({
      data: {
        organizationId: organization.id,
        jobId,
        actorUserId: dispatcherId,
        fromStatus: 'PENDING',
        toStatus: 'PENDING',
        reason: 'Job updated',
        createdAt: new Date(Date.now() + 1000),
      },
    })

    const response = await request(app)
      .get(`/api/v1/jobs/${jobId}/events`)
      .set('Authorization', `Bearer ${token}`)

    expect(response.status).toBe(200)
    expect(response.body.events).toHaveLength(2)
    const [first, second] = response.body.events
    expect(first).toMatchObject({
      jobId,
      actorUserId: dispatcherId,
      fromStatus: null,
      toStatus: 'PENDING',
      reason: 'Job created',
    })
    expect(typeof first.createdAt).toBe('string')
    expect(typeof first.id).toBe('string')
    expect(second.reason).toBe('Job updated')
    expect(new Date(second.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.createdAt).getTime(),
    )
  })

  it('enforces auth, view permission, id shape, and cross-org 404', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(jobPayload())
    const jobId = created.body.job.id

    const shadowToken = await tokenFor(shadowEmail)
    const crossOrg = await request(app)
      .get(`/api/v1/jobs/${jobId}/events`)
      .set('Authorization', `Bearer ${shadowToken}`)
    expect(crossOrg.status).toBe(404)
    expect(crossOrg.body.error.code).toBe('not_found')

    const missing = await request(app)
      .get(`/api/v1/jobs/${crypto.randomUUID()}/events`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('not_found')

    const malformed = await request(app)
      .get('/api/v1/jobs/not-a-uuid/events')
      .set('Authorization', `Bearer ${dispatcherToken}`)
    expect(malformed.status).toBe(400)
    expect(malformed.body.error.code).toBe('validation_error')

    const noPermToken = await createNoPermToken()
    const forbiddenResponse = await request(app)
      .get(`/api/v1/jobs/${jobId}/events`)
      .set('Authorization', `Bearer ${noPermToken}`)
    expect(forbiddenResponse.status).toBe(403)
    expect(forbiddenResponse.body.error.code).toBe('forbidden')

    const anonymous = await request(app).get(`/api/v1/jobs/${jobId}/events`)
    expect(anonymous.status).toBe(401)
    expect(anonymous.body.error.code).toBe('unauthorized')
  })
})

describe('audit separation (T4)', () => {
  it('writes best-effort audit on mutating 2xx, none on failures or replays', async () => {
    const token = await tokenFor(dispatcherEmail)
    const key = crypto.randomUUID()
    const payload = jobPayload()

    const created = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(payload)
    expect(created.status).toBe(201)
    const jobId = created.body.job.id

    const entry = await waitForAudit({ resourceId: jobId })
    expect(entry).toMatchObject({
      action: 'POST /jobs',
      resourceType: 'job',
      resourceId: jobId,
    })

    const auditAfterCreate = await ownerDatabase.auditLog.count()
    const eventsAfterCreate = await ownerDatabase.jobEvent.count({
      where: { jobId },
    })
    expect(eventsAfterCreate).toBe(1)

    // Idempotent replay: same 201 body, but no new audit and no new event.
    const replayed = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(payload)
    expect(replayed.status).toBe(201)
    expect(replayed.headers['idempotent-replay']).toBe('true')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await ownerDatabase.auditLog.count()).toBe(auditAfterCreate)
    expect(
      await ownerDatabase.jobEvent.count({ where: { jobId } }),
    ).toBe(eventsAfterCreate)

    // Failures write no audit: validation error and forbidden.
    const invalid = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ ...payload, status: 'COMPLETED' })
    expect(invalid.status).toBe(400)

    const agentToken = await tokenFor(agentEmail)
    const forbiddenResponse = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${agentToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(payload)
    expect(forbiddenResponse.status).toBe(403)

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await ownerDatabase.auditLog.count()).toBe(auditAfterCreate)
  })

  it('keeps timeline and audit as separate stores with separate roles', async () => {
    const token = await tokenFor(dispatcherEmail)
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(jobPayload())
    const jobId = created.body.job.id
    await waitForAudit({ resourceId: jobId })

    // Timeline reads only the durable JobEvent store.
    const timeline = await request(app)
      .get(`/api/v1/jobs/${jobId}/events`)
      .set('Authorization', `Bearer ${token}`)
    expect(timeline.status).toBe(200)
    expect(timeline.body.events).toHaveLength(1)
    expect(timeline.body.events[0]).toMatchObject({
      jobId,
      fromStatus: null,
      toStatus: 'PENDING',
    })
    expect(timeline.body.events[0]).not.toHaveProperty('action')
    expect(timeline.body.events[0]).not.toHaveProperty('resourceType')

    // Audit rows carry operational fields the timeline never has.
    const auditRow = await ownerDatabase.auditLog.findFirstOrThrow({
      where: { resourceId: jobId },
    })
    expect(auditRow.action).toBe('POST /jobs')
    expect(auditRow.resourceType).toBe('job')
    expect(auditRow.requestId).toEqual(expect.any(String))

    // A timeline read is a GET: it must not append to either store.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const auditCount = await ownerDatabase.auditLog.count({
      where: { resourceId: jobId },
    })
    expect(auditCount).toBe(1)
    expect(
      await ownerDatabase.jobEvent.count({ where: { jobId } }),
    ).toBe(1)
  })
})

describe('post-commit adapter seam (T4)', () => {
  it('runs explicit no-op adapter calls after every committed write', async () => {
    const calls = []
    const originalPublish = integrationAdapters.publishJobEvent
    const originalEnqueue = integrationAdapters.enqueueJobWork
    integrationAdapters.publishJobEvent = async (payload) => {
      calls.push(['publish', payload])
    }
    integrationAdapters.enqueueJobWork = async (payload) => {
      calls.push(['enqueue', payload])
    }
    try {
      const token = await tokenFor(dispatcherEmail)
      const created = await request(app)
        .post('/api/v1/jobs')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send(jobPayload())
      expect(created.status).toBe(201)
      const jobId = created.body.job.id

      expect(calls).toHaveLength(2)
      expect(calls[0][0]).toBe('publish')
      expect(calls[1][0]).toBe('enqueue')
      for (const [, payload] of calls) {
        expect(payload.jobId).toBe(jobId)
        expect(typeof payload.organizationId).toBe('string')
      }
    } finally {
      integrationAdapters.publishJobEvent = originalPublish
      integrationAdapters.enqueueJobWork = originalEnqueue
    }
  })

  it('leaves the commit and board correct when a post-commit hook throws', async () => {
    const originalPublish = integrationAdapters.publishJobEvent
    integrationAdapters.publishJobEvent = async () => {
      throw new Error('socket fan-out exploded')
    }
    try {
      const token = await tokenFor(dispatcherEmail)
      const created = await request(app)
        .post('/api/v1/jobs')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send(jobPayload())
      // Commit already happened — the hook failure must not fail the request.
      expect(created.status).toBe(201)
      const jobId = created.body.job.id

      const board = await request(app)
        .get('/api/v1/jobs')
        .set('Authorization', `Bearer ${token}`)
      expect(board.status).toBe(200)
      expect(board.headers['x-board-cache']).toBe('MISS')
      expect(board.body.jobs.map((job) => job.id)).toContain(jobId)

      const detail = await request(app)
        .get(`/api/v1/jobs/${jobId}`)
        .set('Authorization', `Bearer ${token}`)
      expect(detail.status).toBe(200)
      expect(detail.body.job.id).toBe(jobId)
    } finally {
      integrationAdapters.publishJobEvent = originalPublish
    }
  })

  it('never enqueues, publishes, or invalidates inside a transaction', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const src = (relative) =>
      readFileSync(path.join(here, '..', '..', relative), 'utf8')
    const forbiddenTokens = [
      'publishJobEvent',
      'enqueueJobWork',
      'invalidateBoardCache',
      'boardCache',
      'integration-adapters',
    ]
    const serviceFiles = [
      'services/job-service.js',
      'services/transaction.js',
      'services/assignment-service.js',
      'lib/idempotency.js',
      'lib/sequence.js',
    ]
    for (const file of serviceFiles) {
      const full = path.join(here, '..', '..', file)
      if (!existsSync(full)) continue
      const content = src(file)
      for (const token of forbiddenTokens) {
        expect(
          content.includes(token),
          `${file} must not reference ${token}`,
        ).toBe(false)
      }
    }

    // The route wires the seam only after the committed service promise.
    const routes = src('routes/jobs.js')
    const commitIndex = routes.indexOf('await createJob')
    expect(commitIndex).toBeGreaterThan(-1)
    for (const token of [
      'invalidateBoardCache',
      'publishJobEvent',
      'enqueueJobWork',
    ]) {
      // Imports live at the top of the file, so search from the commit point.
      expect(routes.indexOf(token, commitIndex)).toBeGreaterThan(commitIndex)
    }
  })
})
