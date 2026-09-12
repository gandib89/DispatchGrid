import crypto from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { QueueEvents, createNodeRedisClient } from 'bullmq'
import { createClient } from 'redis'
import { seedDatabase } from '../../../prisma/seed.js'
import { app } from '../../app.js'
import { prisma } from '../../db/client.js'
import { signAccessToken } from '../../auth/tokens.js'
import { env } from '../../env.js'
import { clearBoardCache } from '../../routes/jobs.js'
import { QUEUE_NAMES, closeQueues, getQueue } from '../../lib/queue/index.js'
import { startWorker, stopWorker } from '../../worker.js'
import { createOwnerTestClient, resetDatabase } from '../helpers.js'

const ownerDatabase = createOwnerTestClient()

const dispatcherEmail = 'dispatcher@dispatchgrid.local'

let queueEvents
let eventsRaw

beforeAll(async () => {
  for (const name of Object.values(QUEUE_NAMES)) {
    await getQueue(name).obliterate({ force: true })
  }
  await startWorker({ prisma: ownerDatabase })
  eventsRaw = createClient({ url: env.REDIS_URL })
  queueEvents = new QueueEvents(QUEUE_NAMES.jobEvents, {
    connection: createNodeRedisClient(eventsRaw),
  })
  await queueEvents.waitUntilReady()
})

beforeEach(async () => {
  clearBoardCache()
  await resetDatabase(ownerDatabase)
  await seedDatabase(ownerDatabase)
  for (const name of Object.values(QUEUE_NAMES)) {
    await getQueue(name).obliterate({ force: true })
  }
})

afterAll(async () => {
  await queueEvents?.close().catch(() => {})
  if (eventsRaw?.isOpen) await eventsRaw.quit().catch(() => {})
  await stopWorker().catch(() => {})
  await closeQueues()
  await Promise.all([ownerDatabase.$disconnect(), prisma.$disconnect()])
})

async function tokenFor(email) {
  const user = await ownerDatabase.user.findUniqueOrThrow({ where: { email } })
  return signAccessToken(user.id)
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

async function queueCounts() {
  return getQueue(QUEUE_NAMES.jobEvents).getJobCounts('waiting', 'active', 'delayed')
}

async function waitForRequestCompletion(queueEvents, requestId, timeoutMs = 15_000) {
  const queue = getQueue(QUEUE_NAMES.jobEvents)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const jobs = await queue.getJobs(['waiting', 'active', 'completed', 'failed'])
    const match = jobs.find((job) => job.data?.requestId === requestId)
    if (match) {
      const returnvalue = await match.waitUntilFinished(
        queueEvents,
        Math.max(1000, deadline - Date.now()),
      )
      return { job: match, returnvalue }
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for consumption of ${requestId}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

describe('POST /api/v1/jobs end to end', () => {
  it('flows HTTP -> queue -> worker consumption with requestId correlation', async () => {
    const token = await tokenFor(dispatcherEmail)
    const requestId = `req-e2e-${crypto.randomUUID()}`

    const response = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .set('x-request-id', requestId)
      .send(jobPayload())

    expect(response.status).toBe(201)
    expect(response.headers['x-request-id']).toBe(requestId)

    const consumed = await waitForRequestCompletion(queueEvents, requestId)

    expect(consumed.job.data).toMatchObject({ type: 'job-event', requestId })
    expect(consumed.job.data.jobId).toBe(response.body.job.id)
    expect(consumed.returnvalue).toMatchObject({ status: 'consumed', requestId })
  })
})

describe('producer reachability', () => {
  it('an invalid write never reaches the producer (no enqueue before commit)', async () => {
    const token = await tokenFor(dispatcherEmail)
    const before = await queueCounts()

    const response = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ ...jobPayload(), title: undefined })

    expect(response.status).toBe(400)
    expect(await queueCounts()).toEqual(before)
  })

  it('a failed transition never reaches the producer', async () => {
    const token = await tokenFor(dispatcherEmail)
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(jobPayload())
    expect(created.status).toBe(201)
    // Drain the happy-path enqueue so the assertion below only sees new work.
    await waitForRequestCompletion(queueEvents, created.headers['x-request-id'])

    const moved = await request(app)
      .patch(`/api/v1/jobs/${created.body.job.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ title: 'First write', version: 1 })
    expect(moved.status).toBe(200)
    await waitForRequestCompletion(queueEvents, moved.headers['x-request-id'])

    const before = await queueCounts()

    const stale = await request(app)
      .patch(`/api/v1/jobs/${created.body.job.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ title: 'Stale write', version: 1 })

    expect(stale.status).toBe(409)
    expect(await queueCounts()).toEqual(before)
  })
})
