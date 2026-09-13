import { createAdapter } from '@socket.io/redis-adapter'
import { Server } from 'socket.io'
import { verifyAccessToken } from '../../auth/tokens.js'
import { prisma } from '../../db/client.js'
import { env } from '../../env.js'
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
// renaming is a cross-slice breaking change.
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

  if (memberships.length === 0) {
    throw new Error('Organization not found')
  }

  let membership
  if (requestedOrgId) {
    membership = memberships.find((item) => item.organizationId === requestedOrgId) ?? null
    if (!membership) {
      throw new Error('Organization not found')
    }
  } else if (memberships.length === 1) {
    membership = memberships[0]
  } else {
    throw new Error('Organization selection is required')
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
let adapterClients = null

export function getSocketServer() {
  return io
}

// Attach to a real HTTP server (node:http createServer). enableAdapter:false
// skips the Redis adapter for adapter-less unit use; production always adapts.
export async function attachSocketServer(httpServer, { enableAdapter = true } = {}) {
  if (io) {
    throw new Error('Socket server already attached')
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

  if (enableAdapter) {
    const pubClient = createRedisClient()
    await pubClient.connect()
    const subClient = pubClient.duplicate()
    await subClient.connect()
    server.adapter(createAdapter(pubClient, subClient))
    adapterClients = { pubClient, subClient }
  }

  io = server
  return server
}

// Fire-and-forget org publish for T2 routes/adapters: emits to the derived
// room on this instance; the Redis adapter fans out to every instance.
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

// Test/shutdown helper mirroring closeQueues/closePositionCache: closes the
// server, then its dedicated adapter pair. Idempotent.
export async function closeSocketServer() {
  const current = io
  io = null
  const clients = adapterClients
  adapterClients = null

  if (current) {
    await current.close()
  }
  if (clients) {
    await clients.subClient.quit().catch(() => {})
    await clients.pubClient.quit().catch(() => {})
  }
}
