import http from 'node:http'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { io as ioClient } from 'socket.io-client'
import { seedDatabase } from '../../../prisma/seed.js'
import { app } from '../../app.js'
import { signAccessToken } from '../../auth/tokens.js'
import { prisma } from '../../db/client.js'
import { env } from '../../env.js'
import {
  attachSocketServer,
  closeSocketServer,
  getSocketServer,
  orgRoom,
  publishToOrg,
} from '../../lib/realtime/socket-server.js'
import { createIdentityFixture, createOwnerTestClient, resetDatabase } from '../helpers.js'

// B15-T1 (#44) socket seam against real Redis + Postgres: handshake auth,
// server-derived org rooms, org isolation, and the publish/close helpers.
// supertest cannot take socket connections, so each test builds a real
// http.createServer(app) on an ephemeral port. app.js itself is never changed:
// importing it opens no port and no Redis connection.

const ownerDatabase = createOwnerTestClient()

const dispatcherEmail = 'dispatcher@dispatchgrid.local'
const shadowEmail = 'agent@shadow.dispatchgrid.local'

let httpServer
let url

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
  await seedDatabase(ownerDatabase)

  httpServer = http.createServer(app)
  await attachSocketServer(httpServer)
  await new Promise((resolve) => httpServer.listen(0, resolve))
  url = `http://localhost:${httpServer.address().port}`
})

afterEach(async () => {
  await closeSocketServer()
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve))
    httpServer = null
  }
})

async function tokenFor(email) {
  const user = await ownerDatabase.user.findUniqueOrThrow({ where: { email } })
  return { user, token: signAccessToken(user.id) }
}

async function orgIdFor(email) {
  const user = await ownerDatabase.user.findUniqueOrThrow({ where: { email } })
  const membership = await ownerDatabase.membership.findFirstOrThrow({
    where: { userId: user.id },
  })
  return membership.organizationId
}

function connectClient(auth) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { auth, reconnection: false })
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('Timed out waiting for socket connect'))
    }, 5000)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('connect_error', (error) => {
      clearTimeout(timer)
      socket.close()
      reject(error)
    })
  })
}

function waitForEvent(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 5000)
    socket.once(event, (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('socket-server', () => {
  it('derives the org room server-side', () => {
    expect(orgRoom('org-123')).toBe('org:org-123')
  })

  it('connects with a valid JWT and delivers org publishes to the socket', async () => {
    const { token } = await tokenFor(dispatcherEmail)
    const organizationId = await orgIdFor(dispatcherEmail)
    const socket = await connectClient({ token })

    try {
      const received = waitForEvent(socket, 'test-event')
      expect(publishToOrg(organizationId, 'test-event', { hello: 'org' })).toBe(true)
      await expect(received).resolves.toEqual({ hello: 'org' })
    } finally {
      socket.close()
    }
  })

  it('joins exactly the derived org room — the client cannot choose rooms', async () => {
    const { token } = await tokenFor(dispatcherEmail)
    const organizationId = await orgIdFor(dispatcherEmail)
    const socket = await connectClient({ token })

    try {
      // No server handler consumes room requests: a join attempt is ignored.
      socket.emit('join', 'org:evil')
      await sleep(200)

      const serverSocket = getSocketServer().sockets.sockets.get(socket.id)
      expect(serverSocket).toBeDefined()
      expect([...serverSocket.rooms].sort()).toEqual([socket.id, orgRoom(organizationId)].sort())
    } finally {
      socket.close()
    }
  })

  it('refuses a missing token at the same bar as HTTP', async () => {
    await expect(connectClient({})).rejects.toThrow('Authentication is required')
  })

  it('refuses bad, wrong-secret, and expired JWTs', async () => {
    await expect(connectClient({ token: 'not-a-token' })).rejects.toThrow(
      'Invalid or expired access token',
    )

    const { user } = await tokenFor(dispatcherEmail)
    const wrongSecret = jwt.sign({ sub: user.id }, 'x'.repeat(32), { algorithm: 'HS256' })
    await expect(connectClient({ token: wrongSecret })).rejects.toThrow(
      'Invalid or expired access token',
    )

    const expired = jwt.sign(
      { sub: user.id, exp: Math.floor(Date.now() / 1000) - 60 },
      env.JWT_SECRET,
      { algorithm: 'HS256' },
    )
    await expect(connectClient({ token: expired })).rejects.toThrow(
      'Invalid or expired access token',
    )
  })

  it('accepts an Authorization header fallback token', async () => {
    const { token } = await tokenFor(dispatcherEmail)
    const socket = await new Promise((resolve, reject) => {
      const client = ioClient(url, {
        reconnection: false,
        extraHeaders: { Authorization: `Bearer ${token}` },
      })
      const timer = setTimeout(() => {
        client.close()
        reject(new Error('Timed out waiting for socket connect'))
      }, 5000)
      client.once('connect', () => {
        clearTimeout(timer)
        resolve(client)
      })
      client.once('connect_error', (error) => {
        clearTimeout(timer)
        client.close()
        reject(error)
      })
    })

    try {
      expect(socket.connected).toBe(true)
    } finally {
      socket.close()
    }
  })

  it('isolates organizations: Org A never receives Org B events', async () => {
    const dispatcher = await tokenFor(dispatcherEmail)
    const shadow = await tokenFor(shadowEmail)
    const orgA = await orgIdFor(dispatcherEmail)
    const orgB = await orgIdFor(shadowEmail)
    expect(orgA).not.toBe(orgB)

    const socketA = await connectClient({ token: dispatcher.token })
    const socketB = await connectClient({ token: shadow.token })

    const receivedByA = []
    socketA.on('test-event', (payload) => receivedByA.push(payload))

    try {
      const received = waitForEvent(socketB, 'test-event')
      publishToOrg(orgB, 'test-event', { forOrg: 'B' })
      await expect(received).resolves.toEqual({ forOrg: 'B' })

      await sleep(300)
      expect(receivedByA).toEqual([])
    } finally {
      socketA.close()
      socketB.close()
    }
  })

  it('refuses an org hint for an organization the user does not belong to', async () => {
    const { token } = await tokenFor(dispatcherEmail)
    const orgB = await orgIdFor(shadowEmail)
    await expect(connectClient({ token, orgId: orgB })).rejects.toThrow('Organization not found')
  })

  it('honours an org hint for an organization the user belongs to', async () => {
    const { token } = await tokenFor(dispatcherEmail)
    const orgA = await orgIdFor(dispatcherEmail)
    const socket = await connectClient({ token, orgId: orgA })

    try {
      const received = waitForEvent(socket, 'test-event')
      publishToOrg(orgA, 'test-event', { hinted: true })
      await expect(received).resolves.toEqual({ hinted: true })
    } finally {
      socket.close()
    }
  })

  it('requires org selection when the user has multiple memberships', async () => {
    const dispatcher = await ownerDatabase.user.findUniqueOrThrow({
      where: { email: dispatcherEmail },
    })
    await createIdentityFixture(ownerDatabase, { user: dispatcher })
    const { token } = await tokenFor(dispatcherEmail)

    await expect(connectClient({ token })).rejects.toThrow('Organization selection is required')

    const orgA = await orgIdFor(dispatcherEmail)
    const socket = await connectClient({ token, orgId: orgA })
    socket.close()
  })

  it('closeSocketServer detaches the singleton and parks publishes', async () => {
    expect(getSocketServer()).not.toBeNull()

    await closeSocketServer()
    expect(getSocketServer()).toBeNull()
    expect(publishToOrg('any-org', 'test-event', {})).toBe(false)

    // Idempotent: the afterEach close is a no-op.
    await closeSocketServer()
  })
})

afterAll(async () => {
  await ownerDatabase.$disconnect()
  await prisma.$disconnect()
})
