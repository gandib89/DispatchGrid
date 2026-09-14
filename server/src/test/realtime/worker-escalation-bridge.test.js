import crypto from 'node:crypto'
import http from 'node:http'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { io as ioClient } from 'socket.io-client'
import { seedDatabase } from '../../../prisma/seed.js'
import { app } from '../../app.js'
import { signAccessToken } from '../../auth/tokens.js'
import { prisma } from '../../db/client.js'
import { integrationAdapters } from '../../lib/integration-adapters.js'
import {
  REALTIME_EVENTS,
  attachSocketServer,
  closeSocketServer,
} from '../../lib/realtime/socket-server.js'
import { handleSlaCheck } from '../../worker/handlers/sla-check.js'
import { createOwnerTestClient, resetDatabase } from '../helpers.js'

// B15 review drill: a worker-process escalation reaches a socket via the
// send-only Redis bridge. The worker never attaches a socket server, so
// publishToOrg parks there — the drill injects that parked local publish
// while a real socket server stays subscribed, then asserts the socket
// receives the BREACH-only job.escalated payload exactly once, org-scoped.

const ownerDatabase = createOwnerTestClient()

const dispatcherEmail = 'dispatcher@dispatchgrid.local'
const shadowEmail = 'agent@shadow.dispatchgrid.local'

let httpServer
let url
let sockets

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
  await seedDatabase(ownerDatabase)
  sockets = []

  httpServer = http.createServer(app)
  await attachSocketServer(httpServer)
  await new Promise((resolve) => httpServer.listen(0, resolve))
  url = `http://localhost:${httpServer.address().port}`
})

afterEach(async () => {
  for (const socket of sockets) {
    socket.close()
  }
  sockets = []
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

function testLogger() {
  const log = { info() {} }
  log.child = () => log
  return log
}

describe('worker-escalation bridge', () => {
  it('delivers a worker-originated BREACH escalation to the org socket exactly once', async () => {
    const dispatcher = await tokenFor(dispatcherEmail)
    const shadow = await tokenFor(shadowEmail)
    const organizationId = await orgIdFor(dispatcherEmail)

    const socketA = await connectClient({ token: dispatcher.token })
    const shadowSocket = await connectClient({ token: shadow.token })
    const receivedByA = []
    const leakedToShadow = []
    socketA.on(REALTIME_EVENTS.JOB_ESCALATED, (payload) => receivedByA.push(payload))
    shadowSocket.on(REALTIME_EVENTS.JOB_ESCALATED, (payload) => leakedToShadow.push(payload))

    // Durable job committed through the API (its job.created arrives too —
    // nobody listens for it here).
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${dispatcher.token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(jobPayload())
    expect(created.status).toBe(201)

    // Record the BREACH the way the worker does, without publishing yet.
    const result = await handleSlaCheck(
      {
        type: 'sla-check',
        jobId: created.body.job.id,
        organizationId,
        requestId: `req-${crypto.randomUUID()}`,
        threshold: 'BREACH',
        slaPolicyId: crypto.randomUUID(),
        warningMinutesBefore: 30,
        breachMinutesAfter: 15,
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      {
        prisma: ownerDatabase,
        log: testLogger(),
        publishEscalationEvent: async () => {},
        enqueueEscalationNotification: async () => {},
      },
    )
    expect(result.status).toBe('sla-escalated')

    // Worker-originated publish: publishToOrg parks in the worker (no socket
    // server there), so the bridge carries it to the subscribed API instance,
    // which re-emits locally to the org room.
    const received = waitForEvent(socketA, REALTIME_EVENTS.JOB_ESCALATED)
    await integrationAdapters.publishEscalationEvent(
      {
        jobId: created.body.job.id,
        organizationId,
        threshold: 'BREACH',
        requestId: `req-${crypto.randomUUID()}`,
      },
      { publishToOrg: () => false },
    )

    const payload = await received
    expect(Object.keys(payload).sort()).toEqual(['job', 'slaState', 'threshold'])
    expect(payload.job.id).toBe(created.body.job.id)
    expect(payload.threshold).toBe('BREACH')
    expect(payload.slaState).toBe('BREACHED')
    expect(payload.job.slaState).toBe('BREACHED')

    // Exactly once locally, nothing across the org boundary.
    await sleep(400)
    expect(receivedByA).toHaveLength(1)
    expect(leakedToShadow).toEqual([])

    socketA.close()
    shadowSocket.close()
  })
})

afterAll(async () => {
  await Promise.all([ownerDatabase.$disconnect(), prisma.$disconnect()])
})
