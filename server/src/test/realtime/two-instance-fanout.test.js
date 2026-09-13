import crypto from 'node:crypto'
import http from 'node:http'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { io as ioClient } from 'socket.io-client'
import { seedDatabase } from '../../../prisma/seed.js'
import { app } from '../../app.js'
import { signAccessToken } from '../../auth/tokens.js'
import { prisma } from '../../db/client.js'
import {
  REALTIME_EVENTS,
  attachSocketServer,
  closeSocketServer,
} from '../../lib/realtime/socket-server.js'
import { createOwnerTestClient, resetDatabase } from '../helpers.js'

// B15-T3 (#46) two-instance fan-out proof against real Redis + Postgres: two
// real http.createServer(app) instances (A, B) share one Redis via the
// adapter. B attaches last, so a write handled by B's HTTP emits from B and
// reaches a socket on A only through the adapter. The no-adapter run is the
// learning experiment: the same setup loses the event.
//
// SCOPE: in-process publishes only (job.created via the route seam).
// Worker-process escalation parks — no socket server lives in the worker
// (see the WORKER GAP note in lib/integration-adapters.js).

const ownerDatabase = createOwnerTestClient()

const dispatcherEmail = 'dispatcher@dispatchgrid.local'
const shadowEmail = 'agent@shadow.dispatchgrid.local'

let httpServers
let sockets

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
  await seedDatabase(ownerDatabase)
  httpServers = []
  sockets = []
})

afterEach(async () => {
  for (const socket of sockets) {
    socket.close()
  }
  sockets = []
  await closeSocketServer()
  for (const httpServer of httpServers) {
    await new Promise((resolve) => httpServer.close(resolve))
  }
  httpServers = []
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

async function startInstance({ enableAdapter }) {
  const httpServer = http.createServer(app)
  await attachSocketServer(httpServer, { enableAdapter })
  await new Promise((resolve) => httpServer.listen(0, resolve))
  httpServers.push(httpServer)
  return `http://localhost:${httpServer.address().port}`
}

function connectSocket(url, auth) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { auth, reconnection: false })
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('Timed out waiting for socket connect'))
    }, 5000)
    socket.once('connect', () => {
      clearTimeout(timer)
      sockets.push(socket)
      resolve(socket)
    })
    socket.once('connect_error', (error) => {
      clearTimeout(timer)
      socket.close()
      reject(error)
    })
  })
}

function waitForEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs)
    socket.once(event, (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function jobPayload() {
  return {
    title: 'Fix basement pump',
    description: 'Standing water near unit 3',
    address: '1 Main St',
    latitude: 51.5,
    longitude: -0.12,
    priority: 'HIGH',
    dueAt: new Date(Date.now() + 3_600_000).toISOString(),
  }
}

// The write goes through B's HTTP (real fetch to B's port, not supertest),
// so the T2 route seam publishes from instance B.
async function createJobVia(url, token) {
  const response = await fetch(`${url}/api/v1/jobs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify(jobPayload()),
  })
  expect(response.status).toBe(201)
  return response.json()
}

describe('two-instance fan-out', () => {
  it('delivers a write handled by B to a socket on A with the T2 payload shape', async () => {
    const urlA = await startInstance({ enableAdapter: true })
    const urlB = await startInstance({ enableAdapter: true })
    const dispatcher = await tokenFor(dispatcherEmail)
    const shadow = await tokenFor(shadowEmail)
    const organizationId = await orgIdFor(dispatcherEmail)

    const socketA = await connectSocket(urlA, { token: dispatcher.token })
    const shadowSocket = await connectSocket(urlB, { token: shadow.token })
    const leakedToShadow = []
    shadowSocket.on(REALTIME_EVENTS.JOB_CREATED, (payload) => leakedToShadow.push(payload))

    const received = waitForEvent(socketA, REALTIME_EVENTS.JOB_CREATED)
    const { job: created } = await createJobVia(urlB, dispatcher.token)

    const payload = await received
    expect(Object.keys(payload).sort()).toEqual(['job'])
    expect(payload.job.id).toBe(created.id)
    expect(payload.job.status).toBe('PENDING')
    expect(payload.job.organizationId).toBe(organizationId)

    await sleep(400)
    expect(leakedToShadow).toEqual([])
  })

  it('loses the event without the Redis adapter (learning experiment)', async () => {
    const urlA = await startInstance({ enableAdapter: false })
    const urlB = await startInstance({ enableAdapter: false })
    const dispatcher = await tokenFor(dispatcherEmail)

    const socketA = await connectSocket(urlA, { token: dispatcher.token })

    // The write still commits: a parked publish never fails the request.
    await createJobVia(urlB, dispatcher.token)
    await expect(waitForEvent(socketA, REALTIME_EVENTS.JOB_CREATED, 1500)).rejects.toThrow(
      'Timed out waiting for job.created',
    )
  })
})

afterAll(async () => {
  await Promise.all([ownerDatabase.$disconnect(), prisma.$disconnect()])
})
