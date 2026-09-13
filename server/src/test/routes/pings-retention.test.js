import crypto from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { seedDatabase } from '../../../prisma/seed.js'
import { app } from '../../app.js'
import { prisma } from '../../db/client.js'
import { signAccessToken } from '../../auth/tokens.js'
import { createRedisClient } from '../../lib/redis.js'
import { closePositionCache, positionCacheKey } from '../../lib/tracking/position-cache.js'
import { PING_RETENTION_DAYS, pruneExpiredPings } from '../../lib/tracking/ping-retention.js'
import { createOwnerTestClient, resetDatabase } from '../helpers.js'

// B14-T5 (#42) route seam against real Postgres + Redis: 30-day retention
// pruning with cross-table untouched proof, the out-of-order jitter drill
// (stale arrival moves neither the dot nor the newest-read), and the
// Redis-loss drill (wiped hot state falls back to durable reads while job
// create/assign/transition stay correct). Flood isolation lives in
// pings.test.js (extended there with the agent-identity key proof) — this
// file does not re-flood.

const ownerDatabase = createOwnerTestClient()

const adminEmail = 'admin@dispatchgrid.local'
const dispatcherEmail = 'dispatcher@dispatchgrid.local'
const agentEmail = 'agent@dispatchgrid.local'
const shadowEmail = 'agent@shadow.dispatchgrid.local'

let redis

beforeAll(async () => {
  redis = createRedisClient()
  await redis.connect()
})

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
  await seedDatabase(ownerDatabase)
  const keys = await redis.keys('positions:latest:*')
  if (keys.length > 0) await redis.del(keys)
})

afterAll(async () => {
  const keys = await redis.keys('positions:latest:*').catch(() => [])
  if (keys.length > 0) await redis.del(keys).catch(() => {})
  await redis.quit().catch(() => {})
  await closePositionCache()
  await Promise.all([ownerDatabase.$disconnect(), prisma.$disconnect()])
})

async function tokenFor(email) {
  const user = await ownerDatabase.user.findUniqueOrThrow({ where: { email } })
  return signAccessToken(user.id)
}

async function membershipFor(email) {
  const user = await ownerDatabase.user.findUniqueOrThrow({ where: { email } })
  return ownerDatabase.membership.findFirstOrThrow({ where: { userId: user.id } })
}

function pingPayload(overrides = {}) {
  return {
    latitude: 51.5,
    longitude: -0.12,
    accuracy: 5.5,
    recordedAt: new Date().toISOString(),
    ...overrides,
  }
}

function postPing(token, payload) {
  return request(app)
    .post('/api/v1/pings')
    .set('Authorization', `Bearer ${token}`)
    .send(payload ?? pingPayload())
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

describe('30-day ping retention prune', () => {
  it('deletes only rows older than 30 days, org-scoped, leaving job tables untouched', async () => {
    expect(PING_RETENTION_DAYS).toBe(30)
    const now = new Date()
    const cutoff = new Date(now.getTime() - PING_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    const membership = await membershipFor(agentEmail)
    const shadowMembership = await membershipFor(shadowEmail)
    const admin = await ownerDatabase.user.findUniqueOrThrow({ where: { email: adminEmail } })

    // Neighboring-table rows that must survive the prune untouched. (There is
    // no Notification model on this branch, so there is nothing to count for
    // it — the four durable tables that exist are proven below.)
    const job = await ownerDatabase.job.create({
      data: {
        organizationId: membership.organizationId,
        reference: `JOB-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        title: 'Fix basement pump',
        latitude: 51.5,
        longitude: -0.12,
        priority: 'NORMAL',
        status: 'PENDING',
        slaState: 'OK',
        currentAssigneeId: null,
        createdById: admin.id,
        version: 1,
        dueAt: new Date(Date.now() + 3_600_000),
      },
    })
    const agentUser = await ownerDatabase.user.findUniqueOrThrow({ where: { email: agentEmail } })
    await ownerDatabase.assignment.create({
      data: { organizationId: membership.organizationId, jobId: job.id, agentId: agentUser.id },
    })
    await ownerDatabase.jobEvent.create({
      data: { organizationId: membership.organizationId, jobId: job.id, toStatus: 'PENDING' },
    })
    await ownerDatabase.escalation.create({
      data: { organizationId: membership.organizationId, jobId: job.id, threshold: 'WARNING' },
    })

    const pingData = (organizationId, agentId, recordedAt) => ({
      organizationId,
      agentId,
      jobId: null,
      latitude: 51.5,
      longitude: -0.12,
      accuracy: 5.5,
      recordedAt,
    })
    const minute = 60_000
    const day = 24 * 60 * minute
    const expired = await ownerDatabase.locationPing.create({
      data: pingData(membership.organizationId, membership.id, new Date(now.getTime() - 31 * day)),
    })
    const justExpired = await ownerDatabase.locationPing.create({
      data: pingData(
        membership.organizationId,
        membership.id,
        new Date(cutoff.getTime() - minute),
      ),
    })
    const boundary = await ownerDatabase.locationPing.create({
      data: pingData(membership.organizationId, membership.id, cutoff),
    })
    const fresh = await ownerDatabase.locationPing.create({
      data: pingData(
        membership.organizationId,
        membership.id,
        new Date(cutoff.getTime() + minute),
      ),
    })
    const shadowExpired = await ownerDatabase.locationPing.create({
      data: pingData(
        shadowMembership.organizationId,
        shadowMembership.id,
        new Date(now.getTime() - 31 * day),
      ),
    })

    const countsBefore = {
      jobs: await ownerDatabase.job.count({ where: { organizationId: membership.organizationId } }),
      jobEvents: await ownerDatabase.jobEvent.count({
        where: { organizationId: membership.organizationId },
      }),
      assignments: await ownerDatabase.assignment.count({
        where: { organizationId: membership.organizationId },
      }),
      escalations: await ownerDatabase.escalation.count({
        where: { organizationId: membership.organizationId },
      }),
    }

    const result = await pruneExpiredPings({ organizationId: membership.organizationId, now })

    expect(result.deleted).toBe(2)
    expect(result.cutoff.getTime()).toBe(cutoff.getTime())
    for (const id of [expired.id, justExpired.id]) {
      await expect(ownerDatabase.locationPing.findUnique({ where: { id } })).resolves.toBeNull()
    }
    for (const id of [boundary.id, fresh.id, shadowExpired.id]) {
      await expect(
        ownerDatabase.locationPing.findUniqueOrThrow({ where: { id } }),
      ).resolves.toBeDefined()
    }

    expect(await ownerDatabase.job.count({ where: { organizationId: membership.organizationId } })).toBe(
      countsBefore.jobs,
    )
    expect(
      await ownerDatabase.jobEvent.count({ where: { organizationId: membership.organizationId } }),
    ).toBe(countsBefore.jobEvents)
    expect(
      await ownerDatabase.assignment.count({ where: { organizationId: membership.organizationId } }),
    ).toBe(countsBefore.assignments)
    expect(
      await ownerDatabase.escalation.count({ where: { organizationId: membership.organizationId } }),
    ).toBe(countsBefore.escalations)
  })
})

describe('out-of-order drill', () => {
  it('stale arrival changes neither the cached dot nor the durable newest-read', async () => {
    const agentToken = await tokenFor(agentEmail)
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const membership = await membershipFor(agentEmail)

    const newer = await postPing(
      agentToken,
      pingPayload({ latitude: 51.5, recordedAt: '2026-09-13T10:01:00.000Z' }),
    )
    expect(newer.status).toBe(201)
    const older = await postPing(
      agentToken,
      pingPayload({ latitude: 40.0, recordedAt: '2026-09-13T10:00:00.000Z' }),
    )
    expect(older.status).toBe(201)

    const cached = await request(app)
      .get(`/api/v1/pings/latest/${membership.id}`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
    expect(cached.status).toBe(200)
    expect(cached.body.position).toMatchObject({
      latitude: 51.5,
      recordedAt: '2026-09-13T10:01:00.000Z',
      source: 'cache',
    })

    // Forced miss: the durable newest-read must agree with the dot.
    await redis.del(positionCacheKey(membership.organizationId, membership.id))
    const fallback = await request(app)
      .get(`/api/v1/pings/latest/${membership.id}`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
    expect(fallback.status).toBe(200)
    expect(fallback.body.position).toMatchObject({
      latitude: 51.5,
      recordedAt: '2026-09-13T10:01:00.000Z',
      source: 'database',
    })

    // History keeps both arrivals; only the read view is newest-wins.
    expect(
      await ownerDatabase.locationPing.count({
        where: { organizationId: membership.organizationId, agentId: membership.id },
      }),
    ).toBe(2)
  })
})

describe('Redis-loss drill', () => {
  it('wiped hot state degrades reads to fallback while job create/assign/transition stay correct', async () => {
    const agentToken = await tokenFor(agentEmail)
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const membership = await membershipFor(agentEmail)
    const agentUser = await ownerDatabase.user.findUniqueOrThrow({ where: { email: agentEmail } })

    const posted = await postPing(agentToken, pingPayload({ latitude: 51.5 }))
    expect(posted.status).toBe(201)
    const hit = await request(app)
      .get(`/api/v1/pings/latest/${membership.id}`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
    expect(hit.status).toBe(200)
    expect(hit.body.position.source).toBe('cache')

    // Redis removed mid-session: every hot key gone, durable truth intact.
    const keys = await redis.keys('positions:latest:*')
    expect(keys.length).toBeGreaterThan(0)
    await redis.del(keys)

    const degraded = await request(app)
      .get(`/api/v1/pings/latest/${membership.id}`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
    expect(degraded.status).toBe(200)
    expect(degraded.body.position.source).toBe('database')
    const hitFields = { ...hit.body.position }
    const degradedFields = { ...degraded.body.position }
    delete hitFields.source
    delete degradedFields.source
    expect(degradedFields).toEqual(hitFields)

    // Job truth never depended on the hot store: full create/assign/transition.
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(jobPayload({ title: 'Works through Redis loss' }))
    expect(created.status).toBe(201)

    const assigned = await request(app)
      .post(`/api/v1/jobs/${created.body.job.id}/assign`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: agentUser.id, version: created.body.job.version })
    expect(assigned.status).toBe(200)
    expect(assigned.body.job.status).toBe('ASSIGNED')

    const accepted = await request(app)
      .post(`/api/v1/jobs/${created.body.job.id}/accept`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ version: assigned.body.job.version })
    expect(accepted.status).toBe(200)

    const started = await request(app)
      .post(`/api/v1/jobs/${created.body.job.id}/start`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ version: accepted.body.job.version })
    expect(started.status).toBe(200)
    expect(started.body.job.status).toBe('IN_PROGRESS')

    // Ping writes keep working and re-warm the dot once hot state returns.
    const reposted = await postPing(agentToken, pingPayload({ latitude: 52.0 }))
    expect(reposted.status).toBe(201)
    const rewarmed = await request(app)
      .get(`/api/v1/pings/latest/${membership.id}`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
    expect(rewarmed.status).toBe(200)
    expect(rewarmed.body.position).toMatchObject({ latitude: 52.0, source: 'cache' })
  })
})
