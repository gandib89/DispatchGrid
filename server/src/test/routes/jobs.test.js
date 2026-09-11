import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { seedDatabase } from '../../../prisma/seed.js'
import { app } from '../../app.js'
import { prisma } from '../../db/client.js'
import { signAccessToken } from '../../auth/tokens.js'
import { clearBoardCache } from '../../routes/jobs.js'
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

async function demoOrg() {
  return ownerDatabase.organization.findFirstOrThrow({
    where: { slug: 'dispatchgrid-demo' },
  })
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

async function insertJobFixture(organizationId, createdById, overrides = {}) {
  const suffix = crypto.randomUUID().slice(0, 8)
  return ownerDatabase.job.create({
    data: {
      organizationId,
      reference: `JOB-2026-00${suffix}`,
      title: `Fixture ${suffix}`,
      latitude: 51.5,
      longitude: -0.12,
      createdById,
      dueAt: new Date(Date.now() + 3_600_000),
      ...overrides,
    },
  })
}

describe('POST /api/v1/jobs', () => {
  it('creates a job with 201 and a serialized body', async () => {
    const token = await tokenFor(dispatcherEmail)
    const response = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(jobPayload())

    expect(response.status).toBe(201)
    expect(response.headers['idempotent-replay']).toBeUndefined()
    expect(response.body.job.reference).toMatch(/^JOB-\d{4}-\d{6}$/)
    expect(response.body.job).toMatchObject({
      title: 'Fix basement pump',
      priority: 'HIGH',
      status: 'PENDING',
      version: 1,
    })
    expect(typeof response.body.job.dueAt).toBe('string')
  })

  it('replays the identical response for the same key and body without duplicating', async () => {
    const token = await tokenFor(dispatcherEmail)
    const key = crypto.randomUUID()
    const payload = jobPayload()
    const first = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(payload)
    const second = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(payload)

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.headers['idempotent-replay']).toBe('true')
    expect(second.body).toEqual(first.body)
    const organization = await demoOrg()
    const count = await ownerDatabase.job.count({
      where: { organizationId: organization.id },
    })
    expect(count).toBe(1)
  })

  it('rejects the same key with a different body', async () => {
    const token = await tokenFor(dispatcherEmail)
    const key = crypto.randomUUID()
    const first = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(jobPayload())
    const second = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(jobPayload({ title: 'Something else entirely' }))

    expect(first.status).toBe(201)
    expect(second.status).toBe(422)
    expect(second.body.error.code).toBe('idempotency_key_reuse')
  })

  it('rejects unknown fields instead of ignoring them', async () => {
    const token = await tokenFor(dispatcherEmail)
    const response = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ ...jobPayload(), status: 'COMPLETED' })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('validation_error')
  })

  it('enforces the permission matrix and authentication', async () => {
    const agentToken = await tokenFor(agentEmail)
    const forbiddenResponse = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${agentToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(jobPayload())

    expect(forbiddenResponse.status).toBe(403)
    expect(forbiddenResponse.body.error.code).toBe('forbidden')

    const noPermToken = await createNoPermToken()
    const noPermResponse = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${noPermToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(jobPayload())

    expect(noPermResponse.status).toBe(403)
    expect(noPermResponse.body.error.code).toBe('forbidden')

    const anonymousResponse = await request(app)
      .post('/api/v1/jobs')
      .send(jobPayload())

    expect(anonymousResponse.status).toBe(401)
    expect(anonymousResponse.body.error.code).toBe('unauthorized')
  })
})

describe('GET /api/v1/jobs/:id', () => {
  it('always reads fresh state and returns the current version', async () => {
    const token = await tokenFor(dispatcherEmail)
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(jobPayload())
    const jobId = created.body.job.id

    const first = await request(app)
      .get(`/api/v1/jobs/${jobId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(first.status).toBe(200)
    expect(first.body.job.version).toBe(1)

    await ownerDatabase.job.update({
      where: { id: jobId },
      data: { title: 'Changed behind the cache', version: 2 },
    })

    const second = await request(app)
      .get(`/api/v1/jobs/${jobId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(second.status).toBe(200)
    expect(second.body.job.title).toBe('Changed behind the cache')
    expect(second.body.job.version).toBe(2)
  })

  it('returns 404 for cross-organization reads, never 403', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(jobPayload())

    const shadowToken = await tokenFor(shadowEmail)
    const crossOrg = await request(app)
      .get(`/api/v1/jobs/${created.body.job.id}`)
      .set('Authorization', `Bearer ${shadowToken}`)
    expect(crossOrg.status).toBe(404)
    expect(crossOrg.body.error.code).toBe('not_found')

    const missing = await request(app)
      .get(`/api/v1/jobs/${crypto.randomUUID()}`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('not_found')
  })

  it('rejects malformed ids and enforces view permission', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const malformed = await request(app)
      .get('/api/v1/jobs/not-a-uuid')
      .set('Authorization', `Bearer ${dispatcherToken}`)
    expect(malformed.status).toBe(400)
    expect(malformed.body.error.code).toBe('validation_error')

    const noPermToken = await createNoPermToken()
    const forbiddenResponse = await request(app)
      .get(`/api/v1/jobs/${crypto.randomUUID()}`)
      .set('Authorization', `Bearer ${noPermToken}`)
    expect(forbiddenResponse.status).toBe(403)
    expect(forbiddenResponse.body.error.code).toBe('forbidden')
  })
})

describe('GET /api/v1/jobs board', () => {
  async function seedBoard() {
    const organization = await demoOrg()
    const dispatcher = await ownerDatabase.user.findUniqueOrThrow({
      where: { email: dispatcherEmail },
    })
    const agent = await ownerDatabase.user.findUniqueOrThrow({
      where: { email: agentEmail },
    })
    const past = new Date(Date.now() - 3_600_000).toISOString()
    const soon = new Date(Date.now() + 3_600_000).toISOString()
    const later = new Date(Date.now() + 7_200_000).toISOString()
    const latest = new Date(Date.now() + 10_800_000).toISOString()
    await insertJobFixture(organization.id, dispatcher.id, {
      reference: 'JOB-2026-000011',
      title: 'Urgent pending',
      priority: 'URGENT',
      status: 'PENDING',
      slaState: 'OK',
      dueAt: new Date(soon),
    })
    await insertJobFixture(organization.id, dispatcher.id, {
      reference: 'JOB-2026-000012',
      title: 'Low cancelled overdue',
      priority: 'LOW',
      status: 'CANCELLED',
      slaState: 'WARNING',
      dueAt: new Date(past),
    })
    await insertJobFixture(organization.id, dispatcher.id, {
      reference: 'JOB-2026-000013',
      title: 'Assigned normal',
      priority: 'NORMAL',
      status: 'ASSIGNED',
      slaState: 'BREACHED',
      currentAssigneeId: agent.id,
      dueAt: new Date(later),
    })
    await insertJobFixture(organization.id, dispatcher.id, {
      reference: 'JOB-2026-000014',
      title: 'High pending',
      priority: 'HIGH',
      status: 'PENDING',
      slaState: 'OK',
      dueAt: new Date(latest),
    })
    return { organization, agent }
  }

  it('lists with pagination and rejects oversized pages and unknown filters', async () => {
    await seedBoard()
    const token = await tokenFor(dispatcherEmail)
    const first = await request(app)
      .get('/api/v1/jobs?page=1&pageSize=2')
      .set('Authorization', `Bearer ${token}`)
    expect(first.status).toBe(200)
    expect(first.body.total).toBe(4)
    expect(first.body.jobs).toHaveLength(2)
    expect(first.body.page).toBe(1)
    expect(first.body.pageSize).toBe(2)

    const second = await request(app)
      .get('/api/v1/jobs?page=2&pageSize=2')
      .set('Authorization', `Bearer ${token}`)
    expect(second.body.jobs).toHaveLength(2)

    const oversized = await request(app)
      .get('/api/v1/jobs?pageSize=101')
      .set('Authorization', `Bearer ${token}`)
    expect(oversized.status).toBe(400)
    expect(oversized.body.error.code).toBe('validation_error')

    const unknownFilter = await request(app)
      .get('/api/v1/jobs?bogus=1')
      .set('Authorization', `Bearer ${token}`)
    expect(unknownFilter.status).toBe(400)
    expect(unknownFilter.body.error.code).toBe('validation_error')
  })

  it('supports status, priority, assignee, SLA, due-before, and sort filters', async () => {
    const { agent } = await seedBoard()
    const token = await tokenFor(dispatcherEmail)
    const get = (query) =>
      request(app)
        .get(`/api/v1/jobs${query}`)
        .set('Authorization', `Bearer ${token}`)

    const pending = await get('?status=PENDING')
    expect(pending.body.total).toBe(2)

    const multi = await get('?status=PENDING&status=CANCELLED')
    expect(multi.body.total).toBe(3)

    const low = await get('?priority=LOW')
    expect(low.body.total).toBe(1)
    expect(low.body.jobs[0].title).toBe('Low cancelled overdue')

    const assigned = await get(`?assigneeId=${agent.id}`)
    expect(assigned.body.total).toBe(1)
    expect(assigned.body.jobs[0].title).toBe('Assigned normal')

    const warning = await get('?slaState=WARNING')
    expect(warning.body.total).toBe(1)
    expect(warning.body.jobs[0].title).toBe('Low cancelled overdue')

    const overdue = await get(`?dueBefore=${new Date().toISOString()}`)
    expect(overdue.body.total).toBe(1)
    expect(overdue.body.jobs[0].title).toBe('Low cancelled overdue')

    const byPriority = await get('?sort=priority&pageSize=100')
    expect(byPriority.status).toBe(200)
    expect(byPriority.body.jobs.map((job) => job.priority)).toEqual([
      'URGENT',
      'HIGH',
      'NORMAL',
      'LOW',
    ])

    const badSort = await get('?sort=title')
    expect(badSort.status).toBe(400)
    expect(badSort.body.error.code).toBe('validation_error')
  })

  it('isolates tenants on the board', async () => {
    await seedBoard()
    const shadowToken = await tokenFor(shadowEmail)
    const response = await request(app)
      .get('/api/v1/jobs')
      .set('Authorization', `Bearer ${shadowToken}`)
    expect(response.status).toBe(200)
    expect(response.body.total).toBe(0)
    expect(response.body.jobs).toEqual([])
  })

  it('hits the cache on repeat reads and invalidates on write', async () => {
    const organization = await demoOrg()
    const dispatcher = await ownerDatabase.user.findUniqueOrThrow({
      where: { email: dispatcherEmail },
    })
    await insertJobFixture(organization.id, dispatcher.id, {
      reference: 'JOB-2026-000021',
    })
    const token = await tokenFor(dispatcherEmail)
    const getBoard = () =>
      request(app).get('/api/v1/jobs').set('Authorization', `Bearer ${token}`)

    const miss = await getBoard()
    expect(miss.status).toBe(200)
    expect(miss.headers['x-board-cache']).toBe('MISS')
    expect(miss.body.total).toBe(1)

    const hit = await getBoard()
    expect(hit.headers['x-board-cache']).toBe('HIT')
    expect(hit.body).toEqual(miss.body)

    // A write that bypasses the route leaves the cached board stale,
    // proving the second read came from the cache rather than the database.
    await insertJobFixture(organization.id, dispatcher.id, {
      reference: 'JOB-2026-000022',
    })
    const stale = await getBoard()
    expect(stale.headers['x-board-cache']).toBe('HIT')
    expect(stale.body.total).toBe(1)

    // A route write invalidates the tenant entries immediately.
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(jobPayload())
    expect(created.status).toBe(201)
    const fresh = await getBoard()
    expect(fresh.headers['x-board-cache']).toBe('MISS')
    expect(fresh.body.total).toBe(3)
  })
})
