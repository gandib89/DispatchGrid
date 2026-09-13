import { createRedisClient } from '../redis.js'
import { logger } from '../logger.js'

// B14-T2 hot store: latest known position per agent, owned here. PostgreSQL
// stays the source of truth — this cache only feeds the map dot, so every
// Redis failure degrades to a miss instead of throwing.

// Five-minute TTL per spec #7: a silent agent's dot goes stale on its own.
export const POSITION_CACHE_TTL_SECONDS = 300

const KEY_PREFIX = 'positions:latest'

// Per-agent key, org-scoped so the same user in two orgs never collides.
export function positionCacheKey(organizationId, agentId) {
  return `${KEY_PREFIX}:${organizationId}:${agentId}`
}

// One shared client per process from the B11 factory — never per request.
// Callers (and tests) may pass options.client to use another connection.
let sharedClient = null

async function getSharedClient() {
  if (!sharedClient) sharedClient = createRedisClient()
  if (!sharedClient.isOpen) await sharedClient.connect()
  return sharedClient
}

// Test/shutdown helper: drops the shared client. Never called per request.
export async function closePositionCache() {
  if (sharedClient) {
    await sharedClient.quit().catch(() => {})
    sharedClient = null
  }
}

function recordedAtMs(value) {
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

function parsePosition(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const position = JSON.parse(raw)
    return position && typeof position === 'object' ? position : null
  } catch {
    return null
  }
}

// Cache-first read for the dispatcher path (T4 adds the PG fallback on miss).
// Returns { hit: true, position } or { hit: false, degraded?: true }.
export async function readPosition({ organizationId, agentId }, options = {}) {
  const client = options.client ?? (await getSharedClient().catch(() => null))
  if (!client) return { hit: false, degraded: true }
  try {
    const position = parsePosition(await client.get(positionCacheKey(organizationId, agentId)))
    if (!position || position.organizationId !== organizationId || position.agentId !== agentId) {
      return { hit: false }
    }
    return { hit: true, position }
  } catch (error) {
    logger.warn({ error, organizationId, agentId }, 'Position cache read degraded to miss')
    return { hit: false, degraded: true }
  }
}

// Latest-position write with the no-backwards rule: an arrival older than (or
// equal to) the cached recordedAt never overwrites it — equal is idempotent.
// Returns { stored: boolean, position, degraded?: true }.
export async function writePosition(input, options = {}) {
  const { organizationId, agentId } = input
  const client = options.client ?? (await getSharedClient().catch(() => null))
  if (!client) return { stored: false, degraded: true }
  try {
    const key = positionCacheKey(organizationId, agentId)
    const existing = parsePosition(await client.get(key))
    if (existing && existing.organizationId === organizationId) {
      const existingMs = recordedAtMs(existing.recordedAt)
      const incomingMs = recordedAtMs(input.recordedAt)
      if (existingMs !== null && (incomingMs === null || incomingMs <= existingMs)) {
        return { stored: false, position: existing }
      }
    }
    const position = {
      latitude: input.latitude,
      longitude: input.longitude,
      accuracy: input.accuracy,
      recordedAt: input.recordedAt,
      organizationId,
      agentId,
    }
    await client.set(key, JSON.stringify(position), {
      EX: options.ttlSeconds ?? POSITION_CACHE_TTL_SECONDS,
    })
    return { stored: true, position }
  } catch (error) {
    logger.warn({ error, organizationId, agentId }, 'Position cache write degraded')
    return { stored: false, degraded: true }
  }
}
