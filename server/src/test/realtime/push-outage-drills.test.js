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
import { queueMetrics, resetQueueMetrics } from '../../lib/queue/metrics.js'
import { createOwnerTestClient, resetDatabase } from '../helpers.js'

// B15-T5 (#48) push-outage drills on real Postgres + Redis, in the B10/B11
// drill style and on the T3 two-instance base: two real
// http.createServer(app) instances (A, B) share one Redis via the adapter,
// the socket lives on A, and every write goes through B's HTTP.
//
// Drill 1 kills the push tier mid-session (closeSocketServer — the seam where
// publishToOrg parks): publishes degrade warned + metered, every business
// request stays 2xx, and board/detail/positions reads stay exact off
// PostgreSQL truth. Re-attaching proves delivery resumes.
//
// Drill 2 drops the client socket while the tier stays alive: writes made
// while disconnected resolve into exact state after a single reconnect
// refresh (push has no backlog by design — the refresh is the repair).
//
// DEVIATION (honest, pre-existing): killing the whole Redis container also
// stalls BullMQ enqueue (queue.add awaits Redis with no timeout — B11 owns
// that path), so the request would hang instead of staying 2xx. The drills
// kill the push tier only, which is the "losing push" the spec cares about:
// losing push delays visibility, never correctness.

const ownerDatabase = createOwnerTestClient()

const dispatcherEmail = 'dispatcher@dispatchgrid.local'
const agentEmail = 'agent@dispatchgrid.local'

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
  return signAccessToken(user.id)
}

async function membershipIdFor(email) {
  const user = await ownerDatabase.user.findUniqueOrThrow({ where: { email } })
  const membership = await ownerDatabase.membership.findFirstOrThrow({
    where: { userId: user.id },
  })
  return membership.id
}

async function startInstance() {
  const httpServer = http.createServer(app)
  await attachSocketServer(httpServer, { enableAdapter: true })
  await new Promise((resolve) => httpServer.listen(0, resolve))
  httpServers.push(httpServer)
  return `http://localhost:${httpServer.address().port}`
}

// API tier up, push tier down: a plain HTTP server with no socket attached.
// Models the degraded phase — requests must stay 2xx off PostgreSQL while
// every publish parks at the publishToOrg seam (warned + metered).
async function startPushlessInstance() {
  const httpServer = http.createServer(app)
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

async function postJob(url, token, overrides) {
  const response = await fetch(`${url}/api/v1/jobs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify(jobPayload(overrides)),
  })
  return response
}

async function patchJob(url, token, id, version, body) {
  return fetch(`${url}/api/v1/jobs/${id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ version, ...body }),
  })
}

async function cancelJob(url, token, id, version) {
  return fetch(`${url}/api/v1/jobs/${id}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ version, reason: 'No longer needed' }),
  })
}

async function postPing(url, token, body) {
  return fetch(`${url}/api/v1/pings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

async function readBoard(url, token) {
  const response = await fetch(`${url}/api/v1/jobs`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(response.status).toBe(200)
  return response.json()
}

async function readDetail(url, token, id) {
  const response = await fetch(`${url}/api/v1/jobs/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(response.status).toBe(200)
  return response.json()
}

async function readLatest(url, token) {
  const response = await fetch(`${url}/api/v1/pings/latest`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(response.status).toBe(200)
  return response.json()
}

describe('push-outage drills', () => {
  it('push-tier kill: publishes degrade metered, requests stay 2xx, PG truth stays exact, delivery resumes on re-attach', async () => {
    const urlA = await startInstance()
    const urlB = await startInstance()
    const dispatcher = await tokenFor(dispatcherEmail)
    const agent = await tokenFor(agentEmail)
    const agentMembershipId = await membershipIdFor(agentEmail)

    // Baseline: the session is live — a write through B reaches the socket on A.
    const socketA = await connectSocket(urlA, { token: dispatcher })
    const baselineReceived = waitForEvent(socketA, REALTIME_EVENTS.JOB_CREATED)
    const baseline = await postJob(urlB, dispatcher)
    expect(baseline.status).toBe(201)
    const { job: baselineJob } = await baseline.json()
    const baselinePayload = await baselineReceived
    expect(baselinePayload.job.id).toBe(baselineJob.id)

    // Kill the push tier mid-session (io.close() takes the two adapted HTTP
    // servers with it — hence the push-less instance below for the degraded
    // phase). The client socket drops with it.
    socketA.close()
    sockets = sockets.filter((socket) => socket !== socketA)
    await closeSocketServer()
    const urlP = await startPushlessInstance()

    // Degraded writes: every business request stays 2xx with push parked.
    resetQueueMetrics()
    const created = await postJob(urlP, dispatcher, { title: 'Outage job keeps committing' })
    expect(created.status).toBe(201)
    const { job: outageJob } = await created.json()

    const patched = await patchJob(urlP, dispatcher, outageJob.id, outageJob.version, {
      title: 'Outage job keeps committing urgently',
    })
    expect(patched.status).toBe(200)

    const pingAt = new Date().toISOString()
    const pinged = await postPing(urlP, agent, {
      latitude: 51.51,
      longitude: -0.13,
      accuracy: 5.5,
      recordedAt: pingAt,
    })
    expect(pinged.status).toBe(201)

    // One metered degradation per parked publish (created, updated, moved).
    expect(queueMetrics.enqueueFailuresTotal).toBeGreaterThanOrEqual(3)

    // PostgreSQL truth stays exact throughout — board, detail, positions.
    const board = await readBoard(urlP, dispatcher)
    const boardJob = board.jobs.find((item) => item.id === outageJob.id)
    expect(boardJob.title).toBe('Outage job keeps committing urgently')
    expect(boardJob.status).toBe('PENDING')
    expect(board.jobs.find((item) => item.id === baselineJob.id)).toBeDefined()

    const detail = await readDetail(urlP, dispatcher, outageJob.id)
    expect(detail.job.title).toBe('Outage job keeps committing urgently')
    expect(detail.job.version).toBe(outageJob.version + 1)

    const latest = await readLatest(urlP, dispatcher)
    const dot = latest.positions.find((item) => item.agentId === agentMembershipId)
    expect(dot.latitude).toBe(51.51)
    expect(dot.longitude).toBe(-0.13)

    // Reconnect: fresh instances on the same Redis + Postgres (the old HTTP
    // servers die with io.close()), the socket back on C, and a write
    // through D delivers again — losing push only delayed visibility.
    const urlC = await startInstance()
    const urlD = await startInstance()
    const socketC = await connectSocket(urlC, { token: dispatcher })
    const resumed = waitForEvent(socketC, REALTIME_EVENTS.JOB_CREATED)
    const after = await postJob(urlD, dispatcher, { title: 'After the outage' })
    expect(after.status).toBe(201)
    const { job: afterJob } = await after.json()
    const resumedPayload = await resumed
    expect(resumedPayload.job.id).toBe(afterJob.id)

    // One refresh off either instance now shows the whole missed window.
    const refresh = await readBoard(urlC, dispatcher)
    expect(refresh.jobs.map((item) => item.id)).toEqual(
      expect.arrayContaining([baselineJob.id, outageJob.id, afterJob.id]),
    )
  })

  it('missed events: writes while disconnected resolve into exact state after a single reconnect refresh', async () => {
    const urlA = await startInstance()
    const urlB = await startInstance()
    const dispatcher = await tokenFor(dispatcherEmail)
    const agent = await tokenFor(agentEmail)
    const agentMembershipId = await membershipIdFor(agentEmail)

    // Drop: the client socket goes away while the tier stays alive.
    const socketA = await connectSocket(urlA, { token: dispatcher })
    socketA.close()
    sockets = sockets.filter((socket) => socket !== socketA)

    // The whole missed window commits through B: create, field patch, cancel,
    // plus a movement ping. Push has no backlog, so nobody receives these.
    const created = await postJob(urlB, dispatcher, { title: 'Missed window job' })
    expect(created.status).toBe(201)
    const { job: missed } = await created.json()

    const patched = await patchJob(urlB, dispatcher, missed.id, missed.version, {
      title: 'Missed window job urgently',
    })
    expect(patched.status).toBe(200)
    const { job: patchedJob } = await patched.json()

    const cancelled = await cancelJob(urlB, dispatcher, missed.id, patchedJob.version)
    expect(cancelled.status).toBe(200)

    const pingAt = new Date().toISOString()
    const pinged = await postPing(urlB, agent, {
      latitude: 52.5,
      longitude: -1.12,
      accuracy: 4.5,
      recordedAt: pingAt,
    })
    expect(pinged.status).toBe(201)

    // Reconnect — then the single reconciliation refresh off instance A.
    await connectSocket(urlA, { token: dispatcher })
    const board = await readBoard(urlA, dispatcher)
    const boardJob = board.jobs.find((item) => item.id === missed.id)
    expect(boardJob.status).toBe('CANCELLED')
    expect(boardJob.title).toBe('Missed window job urgently')
    expect(boardJob.version).toBe(missed.version + 2)

    const detail = await readDetail(urlA, dispatcher, missed.id)
    expect(detail.job.status).toBe('CANCELLED')
    expect(detail.job.title).toBe('Missed window job urgently')
    expect(detail.job.version).toBe(missed.version + 2)

    const latest = await readLatest(urlA, dispatcher)
    const dot = latest.positions.find((item) => item.agentId === agentMembershipId)
    expect(dot.latitude).toBe(52.5)
    expect(dot.longitude).toBe(-1.12)
  })
})

afterAll(async () => {
  await Promise.all([ownerDatabase.$disconnect(), prisma.$disconnect()])
})
