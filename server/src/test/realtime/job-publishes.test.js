import crypto from 'node:crypto'
import http from 'node:http'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
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
import { queueMetrics, resetQueueMetrics } from '../../lib/queue/metrics.js'
import { handleSlaCheck } from '../../worker/handlers/sla-check.js'
import { createOwnerTestClient, resetDatabase } from '../helpers.js'

// B15-T2 (#45) single-instance delivery at the route seam: every committed
// write publishes its fixed minimal payload to the caller's org room only,
// and a parked publish never fails the business request. supertest drives
// the HTTP writes in-process, so the attached socket server on the same app
// instance receives them directly. Two-instance fan-out rides T3.

const ownerDatabase = createOwnerTestClient()

const dispatcherEmail = 'dispatcher@dispatchgrid.local'
const agentEmail = 'agent@dispatchgrid.local'
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

async function membershipIdFor(email) {
  const user = await ownerDatabase.user.findUniqueOrThrow({ where: { email } })
  const membership = await ownerDatabase.membership.findFirstOrThrow({
    where: { userId: user.id },
  })
  return membership.id
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

async function createJob(token) {
  const response = await request(app)
    .post('/api/v1/jobs')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', crypto.randomUUID())
    .send(jobPayload())
  expect(response.status).toBe(201)
  return response.body.job
}

function testLogger() {
  const log = { info() {} }
  log.child = () => log
  return log
}

describe('realtime publishes', () => {
  it('fixes the event vocabulary T3/T4 consume', () => {
    expect(REALTIME_EVENTS).toEqual({
      JOB_CREATED: 'job.created',
      JOB_UPDATED: 'job.updated',
      JOB_ESCALATED: 'job.escalated',
      AGENT_MOVED: 'agent.moved',
    })
  })

  it('publishes job.created carrying the job to the org room only', async () => {
    const dispatcher = await tokenFor(dispatcherEmail)
    const shadow = await tokenFor(shadowEmail)
    const socketA = await connectClient({ token: dispatcher.token })
    const socketB = await connectClient({ token: shadow.token })
    const missedByB = []
    socketB.on(REALTIME_EVENTS.JOB_CREATED, (payload) => missedByB.push(payload))
    socketB.on(REALTIME_EVENTS.JOB_UPDATED, (payload) => missedByB.push(payload))

    try {
      const received = waitForEvent(socketA, REALTIME_EVENTS.JOB_CREATED)
      const created = await request(app)
        .post('/api/v1/jobs')
        .set('Authorization', `Bearer ${dispatcher.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send(jobPayload())
      expect(created.status).toBe(201)

      const payload = await received
      expect(Object.keys(payload).sort()).toEqual(['job'])
      expect(payload.job.id).toBe(created.body.job.id)
      expect(payload.job.status).toBe('PENDING')

      await sleep(300)
      expect(missedByB).toEqual([])
    } finally {
      socketA.close()
      socketB.close()
    }
  })

  it('publishes job.updated with from/to/actor on a status transition', async () => {
    const dispatcher = await tokenFor(dispatcherEmail)
    const shadow = await tokenFor(shadowEmail)
    const organizationId = await orgIdFor(dispatcherEmail)
    const socketA = await connectClient({ token: dispatcher.token })
    const socketB = await connectClient({ token: shadow.token })
    const missedByB = []
    socketB.on(REALTIME_EVENTS.JOB_UPDATED, (payload) => missedByB.push(payload))

    try {
      const job = await createJob(dispatcher.token)

      const received = waitForEvent(socketA, REALTIME_EVENTS.JOB_UPDATED)
      const cancelled = await request(app)
        .post(`/api/v1/jobs/${job.id}/cancel`)
        .set('Authorization', `Bearer ${dispatcher.token}`)
        .send({ version: job.version, reason: 'No longer needed' })
      expect(cancelled.status).toBe(200)

      const payload = await received
      expect(Object.keys(payload).sort()).toEqual(['actor', 'from', 'job', 'to'])
      expect(payload.job.id).toBe(job.id)
      expect(payload.job.status).toBe('CANCELLED')
      expect(payload.from).toBe('PENDING')
      expect(payload.to).toBe('CANCELLED')
      expect(payload.actor).toEqual({ userId: dispatcher.user.id })
      expect(organizationId).toBe(payload.job.organizationId)

      await sleep(300)
      expect(missedByB).toEqual([])
    } finally {
      socketA.close()
      socketB.close()
    }
  })

  it('publishes job.updated with from equal to to on a field patch', async () => {
    const dispatcher = await tokenFor(dispatcherEmail)
    const socketA = await connectClient({ token: dispatcher.token })

    try {
      const job = await createJob(dispatcher.token)

      const received = waitForEvent(socketA, REALTIME_EVENTS.JOB_UPDATED)
      const patched = await request(app)
        .patch(`/api/v1/jobs/${job.id}`)
        .set('Authorization', `Bearer ${dispatcher.token}`)
        .send({ version: job.version, title: 'Fix basement pump urgently' })
      expect(patched.status).toBe(200)

      const payload = await received
      expect(payload.job.title).toBe('Fix basement pump urgently')
      expect(payload.from).toBe('PENDING')
      expect(payload.to).toBe('PENDING')
      expect(payload.actor).toEqual({ userId: dispatcher.user.id })
    } finally {
      socketA.close()
    }
  })

  it('publishes agent.moved carrying agent, coordinates, and timestamp to the org room only', async () => {
    const dispatcher = await tokenFor(dispatcherEmail)
    const agent = await tokenFor(agentEmail)
    const shadow = await tokenFor(shadowEmail)
    const membershipId = await membershipIdFor(agentEmail)
    const socketA = await connectClient({ token: dispatcher.token })
    const socketB = await connectClient({ token: shadow.token })
    const missedByB = []
    socketB.on(REALTIME_EVENTS.AGENT_MOVED, (payload) => missedByB.push(payload))

    try {
      const recordedAt = new Date().toISOString()
      const received = waitForEvent(socketA, REALTIME_EVENTS.AGENT_MOVED)
      const posted = await request(app)
        .post('/api/v1/pings')
        .set('Authorization', `Bearer ${agent.token}`)
        .send({ latitude: 51.5, longitude: -0.12, accuracy: 5.5, recordedAt })
      expect(posted.status).toBe(201)

      const payload = await received
      expect(payload).toEqual({
        agentId: membershipId,
        latitude: 51.5,
        longitude: -0.12,
        recordedAt,
      })

      await sleep(300)
      expect(missedByB).toEqual([])
    } finally {
      socketA.close()
      socketB.close()
    }
  })

  it('publishes job.escalated with threshold and SLA state on breach side effects', async () => {
    const dispatcher = await tokenFor(dispatcherEmail)
    const shadow = await tokenFor(shadowEmail)
    const organizationId = await orgIdFor(dispatcherEmail)
    const socketA = await connectClient({ token: dispatcher.token })
    const socketB = await connectClient({ token: shadow.token })
    const missedByB = []
    socketB.on(REALTIME_EVENTS.JOB_ESCALATED, (payload) => missedByB.push(payload))

    try {
      const job = await createJob(dispatcher.token)

      const received = waitForEvent(socketA, REALTIME_EVENTS.JOB_ESCALATED)
      const result = await handleSlaCheck(
        {
          type: 'sla-check',
          jobId: job.id,
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
          enqueueEscalationNotification: async () => {},
        },
      )
      expect(result.status).toBe('sla-escalated')

      const payload = await received
      expect(Object.keys(payload).sort()).toEqual(['job', 'slaState', 'threshold'])
      expect(payload.job.id).toBe(job.id)
      expect(payload.threshold).toBe('BREACH')
      expect(payload.slaState).toBe('BREACHED')
      expect(payload.job.slaState).toBe('BREACHED')

      await sleep(300)
      expect(missedByB).toEqual([])
    } finally {
      socketA.close()
      socketB.close()
    }
  })

  // Last: parks the server so later tests are unaffected (beforeEach re-attaches).
  it('still returns 2xx and meters the failure when publish is parked', async () => {
    const dispatcher = await tokenFor(dispatcherEmail)
    await closeSocketServer()

    resetQueueMetrics()
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${dispatcher.token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(jobPayload())
    expect(created.status).toBe(201)
    expect(queueMetrics.realtimePublishFailuresTotal).toBeGreaterThan(0)

    const agent = await tokenFor(agentEmail)
    const posted = await request(app)
      .post('/api/v1/pings')
      .set('Authorization', `Bearer ${agent.token}`)
      .send({
        latitude: 51.5,
        longitude: -0.12,
        accuracy: 5.5,
        recordedAt: new Date().toISOString(),
      })
    expect(posted.status).toBe(201)
  })
})

afterAll(async () => {
  await Promise.all([ownerDatabase.$disconnect(), prisma.$disconnect()])
})
