import { createAdapter } from '@socket.io/redis-adapter'
import { Server } from 'socket.io'
import { verifyAccessToken } from '../../auth/tokens.js'
import { prisma } from '../../db/client.js'
import { env } from '../../env.js'
import { findOrgMembership } from '../membership.js'
import { createRedisClient } from '../redis.js'
import { logger } from '../logger.js'

// B15-T1 (#44): authenticated Socket.IO foundation.
//
// Attached to the real HTTP server from index.js only — app.js never imports
// this module, so importing { app } still opens no port and no Redis
// connection (supertest-safe). The handshake verifies the HS256 JWT
// independently (HTTP auth middleware does not cover sockets), membership is
// looked up server-side, and the socket joins exactly its derived org room.
// Clients can never choose rooms: join() runs only with the derived room.
//
// Cross-instance fan-out rides the Redis adapter on its own dedicated pub/sub
// pair (never the BullMQ or position-cache clients).

// Server-derived room; the single token T2 publish scoping uses.
export function orgRoom(organizationId) {
  return `org:${organizationId}`
}

// B15-T2 (#45): fixed realtime vocabulary. T3/T4 consume these names —
// renaming is a cross-slice breaking change. job.escalated is BREACH-only by
// decision (B13): WARNING records its escalation row and SLA state but
// promises no delivery; only a BREACH threshold fans out.
export const REALTIME_EVENTS = Object.freeze({
  JOB_CREATED: 'job.created',
  JOB_UPDATED: 'job.updated',
  JOB_ESCALATED: 'job.escalated',
  AGENT_MOVED: 'agent.moved',
})

// Server-side membership lookup mirroring middleware/resolve-tenant.js: the
// client may hint an org (auth.orgId), but the join target is always derived
// from its own memberships. Throws with an HTTP-equivalent message.
async function resolveSocketActor(userId, requestedOrgId) {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: {
      role: {
        include: {
          rolePermissions: { include: { permission: true } },
        },
      },
    },
  })

  const { membership, reason } = findOrgMembership(memberships, requestedOrgId)

  if (!membership) {
    if (reason === 'selection-required') {
      throw new Error('Organization selection is required')
    }
    throw new Error('Organization not found')
  }

  return {
    userId,
    organizationId: membership.organizationId,
    membershipId: membership.id,
    roleId: membership.roleId,
    roleName: membership.role.name,
    permissions: membership.role.rolePermissions.map((link) => link.permission.code),
  }
}

// Worker→socket bridge (B15 review): the worker process never attaches a
// socket server, so a worker-originated publish parks at publishToOrg. The
// bridge is a send-only Redis channel — worker/lib publishes
// { orgId, event, payload } JSON via the existing redis client factory, and
// every attached socket server subscribes and re-emits locally (.local, so N
// subscribers deliver once each instead of N adapter broadcasts). Services
// stay socket-free; no new npm deps.
export const REALTIME_BRIDGE_CHANNEL = 'dispatchgrid:realtime-bridge'

// Send-only bridge publish for socket-free processes (worker) and for the
// API fallback when no server is attached here. Returns true when the JSON
// hit Redis, false when Redis is down. Never throws.
export async function publishBridgeEvent(organizationId, event, payload) {
  const client = createRedisClient()
  try {
    await client.connect()
    await client.publish(REALTIME_BRIDGE_CHANNEL, JSON.stringify({ orgId: organizationId, event, payload }))
    return true
  } catch (error) {
    logger.warn({ error, organizationId, event }, 'Realtime bridge publish degraded')
    return false
  } finally {
    await client.quit().catch(() => {})
  }
}

function handshakeToken(socket) {
  const authToken = socket.handshake.auth?.token
  if (typeof authToken === 'string' && authToken.length > 0) {
    return authToken
  }

  const header = socket.handshake.headers?.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim()
    if (token.length > 0) {
      return token
    }
  }

  return null
}

const KNOWN_AUTH_ERRORS = new Set([
  'Authentication is required',
  'Invalid or expired access token',
  'Organization not found',
  'Organization selection is required',
])

let io = null
const attached = []

export function getSocketServer() {
  return io
}

// Attach to a real HTTP server (node:http createServer). enableAdapter:false
// skips the Redis adapter for adapter-less unit use; production always adapts.
//
// Production invariant: exactly one attach per API process (index.js). The
// default keeps the first attach and warns on a second; tests modelling N
// API instances pass allowMultiple:true for newest-wins publishToOrg (T3
// attaches A then B to model two instances sharing one Redis): every attach
// is tracked for close, and publishToOrg emits via the most recently attached
// server — so a write handled by B emits from B and reaches a socket on A
// only through the Redis adapter. The bridge subscription below is
// independent of the adapter: every attach subscribes, including
// adapter-less ones.
export async function attachSocketServer(httpServer, { enableAdapter = true, allowMultiple = false } = {}) {
  if (attached.length > 0 && !allowMultiple) {
    logger.warn('Socket server already attached; keeping the first attach')
    return io
  }

  const server = new Server(httpServer, {
    cors: { origin: env.CLIENT_ORIGIN, credentials: true },
  })

  server.use(async (socket, next) => {
    try {
      const token = handshakeToken(socket)
      if (!token) {
        next(new Error('Authentication is required'))
        return
      }

      let payload
      try {
        payload = verifyAccessToken(token)
      } catch {
        next(new Error('Invalid or expired access token'))
        return
      }

      if (!payload?.sub) {
        next(new Error('Invalid or expired access token'))
        return
      }

      try {
        socket.data.actor = await resolveSocketActor(payload.sub, socket.handshake.auth?.orgId)
      } catch (error) {
        if (error instanceof Error && KNOWN_AUTH_ERRORS.has(error.message)) {
          next(error)
        } else {
          logger.error({ error }, 'Socket handshake membership lookup failed')
          next(new Error('Authentication failed'))
        }
        return
      }

      next()
    } catch (error) {
      logger.error({ error }, 'Socket handshake failed')
      next(error instanceof Error ? error : new Error('Authentication failed'))
    }
  })

  server.on('connection', (socket) => {
    socket.join(orgRoom(socket.data.actor.organizationId))
  })

  let clients = null
  if (enableAdapter) {
    const pubClient = createRedisClient()
    await pubClient.connect()
    const subClient = pubClient.duplicate()
    await subClient.connect()
    server.adapter(createAdapter(pubClient, subClient))
    clients = { pubClient, subClient }
  }

  // Bridge subscription: re-emit worker-originated { orgId, event, payload }
  // locally to the org room. .local keeps each subscriber to its own sockets
  // so N attached servers deliver once each instead of N adapter broadcasts.
  const bridgeClient = createRedisClient()
  await bridgeClient.connect()
  await bridgeClient.subscribe(REALTIME_BRIDGE_CHANNEL, (message) => {
    let parsed
    try {
      parsed = JSON.parse(message)
    } catch {
      return
    }
    if (!parsed?.orgId || !parsed?.event) {
      return
    }
    try {
      server.to(orgRoom(parsed.orgId)).local.emit(parsed.event, parsed.payload)
    } catch (error) {
      logger.warn({ error }, 'Realtime bridge re-emit degraded')
    }
  })

  attached.push({ server, clients, bridgeClient })
  io = server
  return server
}

// Fire-and-forget org publish for T2 routes/adapters: emits to the derived
// room on this instance (the newest attach when several are attached); the
// Redis adapter fans out to every instance.
// Returns true when emitted, false when skipped (no server attached or emit
// failed). Never throws — callers meter a false return and keep the request
// 2xx (PostgreSQL stays the correctness path).
export function publishToOrg(organizationId, event, payload) {
  const current = io
  if (!current) {
    return false
  }

  try {
    current.to(orgRoom(organizationId)).emit(event, payload)
    return true
  } catch (error) {
    logger.warn({ error, organizationId, event }, 'Realtime publish degraded')
    return false
  }
}

// Test/shutdown helper mirroring closeQueues/closePositionCache: closes every
// attached server, then each dedicated adapter pair and bridge subscription.
// Idempotent.
export async function closeSocketServer() {
  const servers = attached.splice(0)
  io = null

  for (const { server, clients, bridgeClient } of servers) {
    if (bridgeClient) {
      await bridgeClient.unsubscribe(REALTIME_BRIDGE_CHANNEL).catch(() => {})
      await bridgeClient.quit().catch(() => {})
    }
    await server.close()
    if (clients) {
      await clients.subClient.quit().catch(() => {})
      await clients.pubClient.quit().catch(() => {})
    }
  }
}
