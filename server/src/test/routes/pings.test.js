import crypto from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { seedDatabase } from '../../../prisma/seed.js'
import { app } from '../../app.js'
import { prisma } from '../../db/client.js'
import { signAccessToken } from '../../auth/tokens.js'
import { createRedisClient } from '../../lib/redis.js'
import {
  closePositionCache,
  positionCacheKey,
  readPosition,
} from '../../lib/tracking/position-cache.js'
import { createOwnerTestClient, resetDatabase } from '../helpers.js'

// B14-T3 (#40) route seam against real Postgres + Redis: strict validation,
// A-8 actor/job authorization, per-agent 120/hour flood guard, durable +
// timestamp-guarded cache writes, tenant scoping end to end.

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
  return ownerDatabase.membership.findFirstOrThrow({
    where: { userId: user.id },
  })
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

async function createJobIn(orgSlug, createdByEmail, overrides = {}) {
  const organization = await ownerDatabase.organization.findFirstOrThrow({
    where: { slug: orgSlug },
  })
  const createdBy = await ownerDatabase.user.findUniqueOrThrow({
    where: { email: createdByEmail },
  })
  return ownerDatabase.job.create({
    data: {
      organizationId: organization.id,
      reference: `JOB-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      title: 'Fix basement pump',
      latitude: 51.5,
      longitude: -0.12,
      priority: 'NORMAL',
      status: 'PENDING',
      slaState: 'OK',
      currentAssigneeId: null,
      createdById: createdBy.id,
      version: 1,
      dueAt: new Date(Date.now() + 3_600_000),
      ...overrides,
    },
  })
}

async function createPeerAgent() {
  const organization = await ownerDatabase.organization.findFirstOrThrow({
    where: { slug: 'dispatchgrid-demo' },
  })
  const role = await ownerDatabase.role.findUniqueOrThrow({
    where: { organizationId_name: { organizationId: organization.id, name: 'AGENT' } },
  })
  const user = await ownerDatabase.user.create({
    data: {
      email: `peer-${crypto.randomUUID()}@example.test`,
      displayName: 'Peer Field Agent',
      passwordHash: 'test-only-password-hash',
    },
  })
  await ownerDatabase.membership.create({
    data: { organizationId: organization.id, userId: user.id, roleId: role.id },
  })
  return signAccessToken(user.id)
}

describe('POST /api/v1/pings', () => {
  it('writes a durable row and the hot cache with 201 exposing only safe fields', async () => {
    const token = await tokenFor(agentEmail)
    const membership = await membershipFor(agentEmail)
    const payload = pingPayload()
    const response = await postPing(token, payload)

    expect(response.status).toBe(201)
    expect(Object.keys(response.body.ping).sort()).toEqual(
      [
        'accuracy',
        'agentId',
        'createdAt',
        'id',
        'jobId',
        'latitude',
        'longitude',
        'organizationId',
        'recordedAt',
      ].sort(),
    )
    expect(response.body.ping).toMatchObject({
      organizationId: membership.organizationId,
      agentId: membership.id,
      jobId: null,
      latitude: 51.5,
      longitude: -0.12,
      accuracy: 5.5,
      recordedAt: payload.recordedAt,
    })
    expect(typeof response.body.ping.createdAt).toBe('string')

    const row = await ownerDatabase.locationPing.findUniqueOrThrow({
      where: { id: response.body.ping.id },
    })
    expect(row).toMatchObject({
      organizationId: membership.organizationId,
      agentId: membership.id,
      jobId: null,
    })

    const cached = await readPosition(
      { organizationId: membership.organizationId, agentId: membership.id },
      { client: redis },
    )
    expect(cached.hit).toBe(true)
    expect(cached.position).toMatchObject({
      latitude: 51.5,
      longitude: -0.12,
      accuracy: 5.5,
      recordedAt: payload.recordedAt,
    })
  })

  it('accepts an omitted or null job linkage and a same-org job linkage', async () => {
    const token = await tokenFor(agentEmail)
    const job = await createJobIn('dispatchgrid-demo', adminEmail)

    const omitted = await postPing(token, pingPayload())
    expect(omitted.status).toBe(201)
    expect(omitted.body.ping.jobId).toBeNull()

    const explicitNull = await postPing(token, pingPayload({ jobId: null }))
    expect(explicitNull.status).toBe(201)
    expect(explicitNull.body.ping.jobId).toBeNull()

    const linked = await postPing(token, pingPayload({ jobId: job.id }))
    expect(linked.status).toBe(201)
    expect(linked.body.ping.jobId).toBe(job.id)
    const row = await ownerDatabase.locationPing.findUniqueOrThrow({
      where: { id: linked.body.ping.id },
    })
    expect(row.jobId).toBe(job.id)
  })

  it('rejects unknown fields — including a spoofed agent identity — and bad values', async () => {
    const token = await tokenFor(agentEmail)
    const peerMembership = await membershipFor(shadowEmail)

    const spoofed = await postPing(token, { ...pingPayload(), agentId: peerMembership.id })
    expect(spoofed.status).toBe(400)
    expect(spoofed.body.error.code).toBe('validation_error')

    const injected = await postPing(token, { ...pingPayload(), injected: true })
    expect(injected.status).toBe(400)
    expect(injected.body.error.code).toBe('validation_error')

    for (const payload of [
      pingPayload({ latitude: 91 }),
      pingPayload({ latitude: -91 }),
      pingPayload({ longitude: 181 }),
      pingPayload({ longitude: -181 }),
      pingPayload({ accuracy: -0.01 }),
      pingPayload({ recordedAt: 'not-a-date' }),
      pingPayload({ recordedAt: 123 }),
      pingPayload({ jobId: 'not-a-uuid' }),
      {},
    ]) {
      const response = await postPing(token, payload)
      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('validation_error')
    }

    expect(await ownerDatabase.locationPing.count()).toBe(0)
  })

  it('rejects unknown query strings via the strict query schema', async () => {
    const token = await tokenFor(agentEmail)
    const response = await request(app)
      .post('/api/v1/pings?injected=true')
      .set('Authorization', `Bearer ${token}`)
      .send(pingPayload())
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('validation_error')
  })

  it('only lets agents and admins submit; dispatchers get 403, anonymous 401', async () => {
    const dispatcherToken = await tokenFor(dispatcherEmail)
    const forbidden = await postPing(dispatcherToken)
    expect(forbidden.status).toBe(403)
    expect(forbidden.body.error.code).toBe('forbidden')

    const anonymous = await request(app).post('/api/v1/pings').send(pingPayload())
    expect(anonymous.status).toBe(401)
    expect(anonymous.body.error.code).toBe('unauthorized')

    const agentToken = await tokenFor(agentEmail)
    expect((await postPing(agentToken)).status).toBe(201)

    const adminToken = await tokenFor(adminEmail)
    expect((await postPing(adminToken)).status).toBe(201)
  })

  it('treats cross-organization and missing job linkage as 404 without writing', async () => {
    const token = await tokenFor(agentEmail)
    const shadowJob = await createJobIn('dispatchgrid-shadow', shadowEmail)

    const crossOrg = await postPing(token, pingPayload({ jobId: shadowJob.id }))
    expect(crossOrg.status).toBe(404)
    expect(crossOrg.body.error.code).toBe('not_found')

    const missing = await postPing(token, pingPayload({ jobId: crypto.randomUUID() }))
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('not_found')

    expect(await ownerDatabase.locationPing.count()).toBe(0)
  })

  it('isolates tenants: same-org shadow ping lands in its own org and cache key', async () => {
    const token = await tokenFor(agentEmail)
    await postPing(token, pingPayload({ latitude: 51.5 }))

    const shadowToken = await tokenFor(shadowEmail)
    const shadowMembership = await membershipFor(shadowEmail)
    const shadowResponse = await postPing(shadowToken, pingPayload({ latitude: 40.0 }))
    expect(shadowResponse.status).toBe(201)
    expect(shadowResponse.body.ping.organizationId).toBe(shadowMembership.organizationId)

    const demoCount = await ownerDatabase.locationPing.count({
      where: { organizationId: (await membershipFor(agentEmail)).organizationId },
    })
    expect(demoCount).toBe(1)

    const shadowCached = await readPosition(
      {
        organizationId: shadowMembership.organizationId,
        agentId: shadowMembership.id,
      },
      { client: redis },
    )
    expect(shadowCached.hit).toBe(true)
    expect(shadowCached.position.latitude).toBe(40.0)

    const demoMembership = await membershipFor(agentEmail)
    const raw = await redis.get(
      positionCacheKey(demoMembership.organizationId, demoMembership.id),
    )
    expect(JSON.parse(raw).latitude).toBe(51.5)
  })

  it('keeps history rows for stale arrivals while the cache keeps the newer dot', async () => {
    const token = await tokenFor(agentEmail)
    const membership = await membershipFor(agentEmail)

    const newer = await postPing(
      token,
      pingPayload({ latitude: 51.5, recordedAt: '2026-09-13T10:01:00.000Z' }),
    )
    expect(newer.status).toBe(201)

    const older = await postPing(
      token,
      pingPayload({ latitude: 40.0, recordedAt: '2026-09-13T10:00:00.000Z' }),
    )
    expect(older.status).toBe(201)

    expect(
      await ownerDatabase.locationPing.count({
        where: { organizationId: membership.organizationId, agentId: membership.id },
      }),
    ).toBe(2)

    const cached = await readPosition(
      { organizationId: membership.organizationId, agentId: membership.id },
      { client: redis },
    )
    expect(cached.hit).toBe(true)
    expect(cached.position.latitude).toBe(51.5)
  })

  it('throttles the 121st ping per agent with a retry hint without throttling a peer', async () => {
    const token = await tokenFor(agentEmail)
    for (let index = 0; index < 120; index += 1) {
      const response = await postPing(token)
      expect(response.status).toBe(201)
    }

    const throttled = await postPing(token)
    expect(throttled.status).toBe(429)
    expect(throttled.body.error.code).toBe('rate_limited')
    expect(throttled.headers['retry-after']).toBeDefined()

    const peerToken = await createPeerAgent()
    const peerResponse = await postPing(peerToken)
    expect(peerResponse.status).toBe(201)
  }, 60_000)
})
