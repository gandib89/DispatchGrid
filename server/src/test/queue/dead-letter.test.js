import crypto from 'node:crypto'
import http from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { seedDatabase } from '../../../prisma/seed.js'
import { app } from '../../app.js'
import { prisma } from '../../db/client.js'
import { signAccessToken } from '../../auth/tokens.js'
import { clearBoardCache } from '../../routes/jobs.js'
import { integrationAdapters } from '../../lib/integration-adapters.js'
import { logger } from '../../lib/logger.js'
import {
  QUEUE_NAMES,
  closeQueues,
  deadLetterIfExhausted,
  enqueueJobEvent,
  getDeadLetterJobs,
  getFailedJobs,
  getQueue,
} from '../../lib/queue/index.js'
import { queueMetrics, resetQueueMetrics } from '../../lib/queue/metrics.js'
import { attachSocketServer, closeSocketServer } from '../../lib/realtime/socket-server.js'
import { startWorker, stopWorker } from '../../worker.js'
import { routeQueueJob } from '../../worker/handlers/index.js'
import { createOwnerTestClient, resetDatabase } from '../helpers.js'

// B11-T5 against real Redis + Postgres. Poison exhausts retries and lands on
// the inspectable queue-level dead-letter path; a Redis outage leaves the
// synchronous job endpoints working per the limiter policy while async pauses;
// wiping Redis proves it holds no irreplaceable business fact; a post-commit
// queue failure is logged + metered and never rolls back the commit.
// (KNOWN QUIRK: no QueueEvents here — failed-state polling avoids the BullMQ
// 6.3.4 blocking-connection wrap; the worker itself already passes
// createNodeRedisClient explicitly.)

const ownerDatabase = createOwnerTestClient()

const dispatcherEmail = 'dispatcher@dispatchgrid.local'

const poisonAttempts = []

async function obliterateQueues() {
  for (const name of Object.values(QUEUE_NAMES)) {
    await getQueue(name).obliterate({ force: true })
  }
}

async function waitForJobState(queueName, jobId, state, timeoutMs = 20_000) {
  const queue = getQueue(queueName)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = await queue.getJob(jobId)
    if (job && (await job.getState()) === state) return job
    if (Date.now() > deadline) throw new Error(`job ${jobId} never reached ${state}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function waitForDeadLetter(requestId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const entries = await getDeadLetterJobs()
    const match = entries.find((entry) => entry.requestId === requestId)
    if (match) return match
    if (Date.now() > deadline) throw new Error(`dead-letter copy for ${requestId} never landed`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

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

beforeAll(async () => {
  await resetDatabase(ownerDatabase)
  await obliterateQueues()
  // Poison-marked payloads always throw (retry, then exhaust); everything else
  // flows through the real handler router.
  await startWorker({
    prisma: ownerDatabase,
    reconciliation: false,
    processor: async (job) => {
      if (job?.data?.requestId?.startsWith('req-poison-')) {
        poisonAttempts.push(job.id)
        throw new Error('poison: simulated permanent failure')
      }
      return routeQueueJob(job, { prisma: ownerDatabase, log: logger })
    },
  })
})

beforeEach(async () => {
  clearBoardCache()
  resetQueueMetrics()
  poisonAttempts.length = 0
  await resetDatabase(ownerDatabase)
  await seedDatabase(ownerDatabase)
  await obliterateQueues()
})

afterAll(async () => {
  await stopWorker().catch(() => {})
  await closeQueues()
  await Promise.all([ownerDatabase.$disconnect(), prisma.$disconnect()])
})

describe('dead-letter path', () => {
  it('poison exhausts retries then lands inspectable (failed set + dead-letter copy)', async () => {
    const requestId = `req-poison-${crypto.randomUUID()}`
    const enqueued = await enqueueJobEvent(
      {
        type: 'job-event',
        jobId: crypto.randomUUID(),
        jobVersion: 0,
        organizationId: crypto.randomUUID(),
        requestId,
      },
      { attempts: 2, backoff: { type: 'exponential', delay: 10 } },
    )

    const failed = await waitForJobState(QUEUE_NAMES.jobEvents, enqueued.id, 'failed')

    expect(poisonAttempts.filter((id) => id === enqueued.id)).toHaveLength(2)
    expect(await failed.getState()).toBe('failed')

    const failedJobs = await getFailedJobs(QUEUE_NAMES.jobEvents)
    const inspected = failedJobs.find((entry) => entry.id === enqueued.id)
    expect(inspected).toMatchObject({
      queue: QUEUE_NAMES.jobEvents,
      requestId,
      attemptsMade: 2,
    })
    expect(inspected.data).toMatchObject({ type: 'job-event', requestId })
    expect(inspected.failedReason).toMatch(/poison/)

    const copy = await waitForDeadLetter(requestId)
    expect(copy).toMatchObject({
      sourceQueue: QUEUE_NAMES.jobEvents,
      jobId: enqueued.id,
      requestId,
      attemptsMade: 2,
    })
    expect(copy.failedReason).toMatch(/poison/)
    expect(queueMetrics.deadLetteredTotal).toBeGreaterThanOrEqual(1)
  })

  it('non-exhausted failures stay out of the dead-letter queue', async () => {
    const forwarded = await deadLetterIfExhausted(
      QUEUE_NAMES.jobEvents,
      {
        id: 'not-yet-exhausted',
        name: 'job-event',
        data: { requestId: 'req-poison-never-sent' },
        opts: { attempts: 5 },
        attemptsMade: 1,
      },
      new Error('transient'),
    )

    expect(forwarded).toBeNull()
    expect(await getDeadLetterJobs()).toEqual([])
    expect(queueMetrics.deadLetteredTotal).toBe(0)
  })

  it('rejects unknown queues at the inspection boundary', async () => {
    await expect(getFailedJobs('no-such-queue')).rejects.toThrow()
  })
})

describe('Redis-out degradation', () => {
  let httpServer

  beforeEach(async () => {
    // The API process always serves sockets (index.js attaches on boot):
    // attach here so the injected queue failure is the only fault the
    // meter counts and the exact toBe(1) below keeps meaning "one cause".
    httpServer = http.createServer(app)
    await attachSocketServer(httpServer)
    await new Promise((resolve) => httpServer.listen(0, resolve))
  })

  afterEach(async () => {
    await closeSocketServer()
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(resolve))
      httpServer = null
    }
  })

  it('REST keeps working per the limiter policy while async pauses', async () => {
    const token = await tokenFor(dispatcherEmail)
    const requestId = `req-redis-out-${crypto.randomUUID()}`
    const original = integrationAdapters.enqueueJobWork
    integrationAdapters.enqueueJobWork = async () => {
      throw new Error('Redis connection lost (simulated outage)')
    }
    try {
      const created = await request(app)
        .post('/api/v1/jobs')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .set('x-request-id', requestId)
        .send(jobPayload())

      // Synchronous path stands: committed, served, inside limiter budget.
      expect(created.status).toBe(201)
      expect(created.headers['x-request-id']).toBe(requestId)

      // Async paused: nothing reached the queue, failure metered once.
      const counts = await getQueue(QUEUE_NAMES.jobEvents).getJobCounts('waiting', 'active', 'delayed')
      expect(counts).toMatchObject({ waiting: 0, active: 0, delayed: 0 })
      expect(queueMetrics.enqueueFailuresTotal).toBe(1)

      const detail = await request(app)
        .get(`/api/v1/jobs/${created.body.job.id}`)
        .set('Authorization', `Bearer ${token}`)
      expect(detail.status).toBe(200)
      expect(detail.body.job.id).toBe(created.body.job.id)

      const board = await request(app).get('/api/v1/jobs').set('Authorization', `Bearer ${token}`)
      expect(board.status).toBe(200)
      expect(board.body.total).toBeGreaterThanOrEqual(1)
    } finally {
      integrationAdapters.enqueueJobWork = original
    }
  })

  it('a post-commit queue failure never rolls back a committed transition', async () => {
    const token = await tokenFor(dispatcherEmail)
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(jobPayload())
    expect(created.status).toBe(201)

    const original = integrationAdapters.enqueueJobWork
    integrationAdapters.enqueueJobWork = async () => {
      throw new Error('Redis connection lost (simulated outage)')
    }
    try {
      const patched = await request(app)
        .patch(`/api/v1/jobs/${created.body.job.id}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ title: 'Retitled during outage', version: created.body.job.version })

      expect(patched.status).toBe(200)
      expect(patched.body.job.title).toBe('Retitled during outage')
      expect(queueMetrics.enqueueFailuresTotal).toBe(1)

      const stored = await ownerDatabase.job.findUniqueOrThrow({ where: { id: created.body.job.id } })
      expect(stored.title).toBe('Retitled during outage')
    } finally {
      integrationAdapters.enqueueJobWork = original
    }
  })
})

describe('Redis holds no irreplaceable fact', () => {
  it('wiping Redis leaves PostgreSQL truth fully servable', async () => {
    const token = await tokenFor(dispatcherEmail)
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(jobPayload({ title: 'Survives Redis wipe' }))
    expect(created.status).toBe(201)

    // Nuke everything Redis knows: pending work, failed sets, dead letters.
    await obliterateQueues()
    expect(await getFailedJobs(QUEUE_NAMES.jobEvents)).toEqual([])
    expect(await getDeadLetterJobs()).toEqual([])

    const detail = await request(app)
      .get(`/api/v1/jobs/${created.body.job.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(detail.status).toBe(200)
    expect(detail.body.job).toMatchObject({ id: created.body.job.id, title: 'Survives Redis wipe' })

    const board = await request(app).get('/api/v1/jobs').set('Authorization', `Bearer ${token}`)
    expect(board.status).toBe(200)
    expect(board.body.jobs.map((job) => job.id)).toContain(created.body.job.id)
  })
})
