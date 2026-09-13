import crypto from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createRedisClient } from '../../lib/redis.js'
import {
  POSITION_CACHE_TTL_SECONDS,
  closePositionCache,
  positionCacheKey,
  readPosition,
  writePosition,
} from '../../lib/tracking/position-cache.js'

// B14-T2 against real Redis: no-backwards rule, TTL expiry, tenant isolation,
// degrade-on-outage. No Postgres, no routes — those arrive in T3/T4.

let redis

function scope() {
  return { organizationId: crypto.randomUUID(), agentId: crypto.randomUUID() }
}

function ping(identity, recordedAt, coords = {}) {
  return {
    ...identity,
    latitude: 51.5,
    longitude: -0.12,
    accuracy: 12,
    recordedAt,
    ...coords,
  }
}

async function clearPositionKeys() {
  const keys = await redis.keys('positions:latest:*')
  for (const key of keys) await redis.del(key)
}

beforeAll(async () => {
  redis = createRedisClient()
  await redis.connect()
})

beforeEach(async () => {
  await clearPositionKeys()
})

afterAll(async () => {
  await clearPositionKeys().catch(() => {})
  await redis.quit().catch(() => {})
  await closePositionCache()
})

describe('position cache (hot store)', () => {
  it('newer-then-older keeps the newer position', async () => {
    const identity = scope()
    const newer = await writePosition(ping(identity, '2026-09-13T10:01:00.000Z'), { client: redis })
    expect(newer.stored).toBe(true)

    const older = await writePosition(
      ping(identity, '2026-09-13T10:00:00.000Z', { latitude: 40.0, longitude: 10.0 }),
      { client: redis },
    )
    expect(older.stored).toBe(false)

    const read = await readPosition(identity, { client: redis })
    expect(read.hit).toBe(true)
    expect(read.position).toMatchObject({ latitude: 51.5, longitude: -0.12 })
  })

  it('older-then-newer advances the cached position', async () => {
    const identity = scope()
    await writePosition(ping(identity, '2026-09-13T10:00:00.000Z'), { client: redis })

    const advanced = await writePosition(
      ping(identity, '2026-09-13T10:01:00.000Z', { latitude: 48.85, longitude: 2.35 }),
      { client: redis },
    )
    expect(advanced.stored).toBe(true)

    const read = await readPosition(identity, { client: redis })
    expect(read.hit).toBe(true)
    expect(read.position).toMatchObject({ latitude: 48.85, longitude: 2.35 })
  })

  it('equal timestamps are idempotent and never regress', async () => {
    const identity = scope()
    const first = await writePosition(ping(identity, '2026-09-13T10:00:00.000Z'), { client: redis })
    expect(first.stored).toBe(true)

    const replay = await writePosition(
      ping(identity, '2026-09-13T10:00:00.000Z', { latitude: 40.0, longitude: 10.0 }),
      { client: redis },
    )
    expect(replay.stored).toBe(false)

    const read = await readPosition(identity, { client: redis })
    expect(read.hit).toBe(true)
    expect(read.position).toMatchObject({ latitude: 51.5, longitude: -0.12 })
  })

  it('TTL expiry yields a miss', async () => {
    const identity = scope()
    await writePosition(ping(identity, '2026-09-13T10:00:00.000Z'), { client: redis, ttlSeconds: 1 })

    expect((await readPosition(identity, { client: redis })).hit).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(await readPosition(identity, { client: redis })).toEqual({ hit: false })
  })

  it('payload carries coords, accuracy, recordedAt, and org scope with a 5-minute TTL', async () => {
    expect(POSITION_CACHE_TTL_SECONDS).toBe(300)
    const identity = scope()
    await writePosition(ping(identity, '2026-09-13T10:00:00.000Z'), { client: redis })

    const raw = await redis.get(positionCacheKey(identity.organizationId, identity.agentId))
    expect(JSON.parse(raw)).toMatchObject({
      latitude: 51.5,
      longitude: -0.12,
      accuracy: 12,
      recordedAt: '2026-09-13T10:00:00.000Z',
      organizationId: identity.organizationId,
      agentId: identity.agentId,
    })

    const ttl = await redis.ttl(positionCacheKey(identity.organizationId, identity.agentId))
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(POSITION_CACHE_TTL_SECONDS)
  })

  it('positions never leak across agents or orgs', async () => {
    const orgA = crypto.randomUUID()
    const writer = { organizationId: orgA, agentId: crypto.randomUUID() }
    await writePosition(ping(writer, '2026-09-13T10:00:00.000Z'), { client: redis })

    expect(await readPosition({ organizationId: orgA, agentId: crypto.randomUUID() }, { client: redis }))
      .toEqual({ hit: false })
    expect(
      await readPosition({ organizationId: crypto.randomUUID(), agentId: writer.agentId }, { client: redis }),
    ).toEqual({ hit: false })
    expect((await readPosition(writer, { client: redis })).hit).toBe(true)
  })

  it('Redis failure degrades instead of throwing', async () => {
    const broken = {
      get: async () => { throw new Error('Redis connection lost (simulated outage)') },
      set: async () => { throw new Error('Redis connection lost (simulated outage)') },
    }
    const identity = scope()

    await expect(readPosition(identity, { client: broken })).resolves.toEqual({
      hit: false,
      degraded: true,
    })
    await expect(writePosition(ping(identity, '2026-09-13T10:00:00.000Z'), { client: broken }))
      .resolves.toEqual({ stored: false, degraded: true })
  })

  it('default shared client serves reads and writes without an injected client', async () => {
    const identity = scope()
    const written = await writePosition(ping(identity, '2026-09-13T10:00:00.000Z'))
    expect(written.stored).toBe(true)

    const read = await readPosition(identity)
    expect(read.hit).toBe(true)
    expect(read.position).toMatchObject({ organizationId: identity.organizationId })
  })
})
