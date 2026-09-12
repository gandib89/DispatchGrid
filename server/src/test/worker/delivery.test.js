import crypto from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { QueueEvents, createNodeRedisClient } from 'bullmq'
import { createClient } from 'redis'
import { env } from '../../env.js'
import { QUEUE_NAMES, closeQueues, enqueueJobEvent, getQueue } from '../../lib/queue/index.js'
import { startWorker, stopWorker } from '../../worker.js'
import { routeQueueJob } from '../../worker/handlers/index.js'
import {
  createOrganizationFixture,
  createOwnerTestClient,
  createUserFixture,
  resetDatabase,
} from '../helpers.js'

// At-least-once delivery proofs (B11-T3) against real Redis + PostgreSQL:
// killing the worker before ack redelivers after restart, poison storms never
// wedge the consumer, and duplicate deliveries corrupt nothing.
//
// Raw node-redis clients are wrapped with createNodeRedisClient: BullMQ builds
// the QueueEvents blocking connection by duplicating the passed connection,
// and a raw duplicate never connects, so an unwrapped client hangs
// waitUntilReady (same quirk as worker.js / runtime.test.js).
const ownerDatabase = createOwnerTestClient()

function jobEventPayload(overrides = {}) {
  return {
    type: 'job-event',
    jobId: crypto.randomUUID(),
    jobVersion: 0,
    organizationId: crypto.randomUUID(),
    requestId: `req-${crypto.randomUUID()}`,
    ...overrides,
  }
}

async function createJobRow() {
  const organization = await createOrganizationFixture(ownerDatabase)
  const user = await createUserFixture(ownerDatabase)
  const job = await ownerDatabase.job.create({
    data: {
      organizationId: organization.id,
      reference: `JOB-${crypto.randomUUID().slice(0, 8)}`,
      title: 'Delivery fixture',
      latitude: 51.5,
      longitude: -0.12,
      createdById: user.id,
      dueAt: new Date(Date.now() + 3_600_000),
    },
  })
  return { organization, job }
}

async function resetQueues() {
  for (const name of Object.values(QUEUE_NAMES)) {
    await getQueue(name).obliterate({ force: true })
  }
}

async function openQueueEvents(name) {
  const raw = createClient({ url: env.REDIS_URL })
  const queueEvents = new QueueEvents(name, { connection: createNodeRedisClient(raw) })
  await queueEvents.waitUntilReady()
  return { queueEvents, raw }
}

async function closeQueueEvents(opened) {
  if (!opened) return
  await opened.queueEvents.close().catch(() => {})
  if (opened.raw?.isOpen) await opened.raw.quit().catch(() => {})
}

async function waitUntil(description, fn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await fn()
    if (result) return result
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

afterAll(async () => {
  await stopWorker().catch(() => {})
  await closeQueues()
  await ownerDatabase.$disconnect().catch(() => {})
})

describe('at-least-once delivery', () => {
  it('redelivers work killed before ack after restart with nothing lost', async () => {
    await resetDatabase(ownerDatabase)
    await resetQueues()
    const { organization, job } = await createJobRow()
    const payload = jobEventPayload({
      jobId: job.id,
      organizationId: organization.id,
      requestId: `req-kill-${crypto.randomUUID()}`,
    })

    // First delivery never acknowledges. Force-closing the worker leaves its
    // lock behind; a new worker must recover the stalled job after restart.
    // Only job-events deliveries count: consuming one now enqueues follow-on
    // notification work (B13) that this same test worker also consumes.
    let attempts = 0
    const processor = async (bullJob) => {
      if (bullJob.queueName !== QUEUE_NAMES.jobEvents) {
        return routeQueueJob(bullJob, { prisma: ownerDatabase })
      }
      attempts += 1
      if (attempts === 1) return new Promise(() => {})
      return routeQueueJob(bullJob, { prisma: ownerDatabase })
    }

    let events = null
    await startWorker({
      prisma: ownerDatabase,
      processor,
      reconciliation: false,
      workerOptions: { lockDuration: 500, stalledInterval: 100 },
    })
    try {
      events = await openQueueEvents(QUEUE_NAMES.jobEvents)
      const enqueued = await enqueueJobEvent(payload)

      await waitUntil('first delivery attempt', () => (attempts >= 1 ? true : undefined))

      // Nothing was acked: the job must not be completed while its worker dies.
      const midJob = await getQueue(QUEUE_NAMES.jobEvents).getJob(enqueued.id)
      expect(await midJob.getState()).not.toBe('completed')

      // Force close models process death: do not drain or acknowledge active work.
      await stopWorker('SIGKILL', { force: true })
      await startWorker({
        prisma: ownerDatabase,
        processor,
        reconciliation: false,
        workerOptions: { lockDuration: 500, stalledInterval: 100 },
      })

      const done = await waitUntil('redelivery completion', async () => {
        const current = await getQueue(QUEUE_NAMES.jobEvents).getJob(enqueued.id)
        return (await current.getState()) === 'completed' ? current : undefined
      })

      expect(attempts).toBe(2)
      expect(done.returnvalue).toMatchObject({
        status: 'consumed',
        jobId: job.id,
        requestId: payload.requestId,
      })

      // Nothing lost: the PostgreSQL row the payload points at is intact.
      const reread = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
      expect(reread.title).toBe(job.title)
      expect(reread.organizationId).toBe(organization.id)
    } finally {
      await closeQueueEvents(events)
      await stopWorker().catch(() => {})
    }
  })

  it('stays up through a malformed-payload storm: poison fails fast, good work still flows', async () => {
    await resetDatabase(ownerDatabase)
    await resetQueues()
    const { organization, job } = await createJobRow()

    let events = null
    await startWorker({ prisma: ownerDatabase, reconciliation: false })
    try {
      events = await openQueueEvents(QUEUE_NAMES.jobEvents)
      const queue = getQueue(QUEUE_NAMES.jobEvents)

      const goodPayload = (requestId) =>
        jobEventPayload({ jobId: job.id, organizationId: organization.id, requestId })
      const goodBefore = await enqueueJobEvent(goodPayload('req-storm-before'))

      // Poison bypasses producer validation via raw add, the way a foreign or
      // outdated writer would deliver it: the consumer boundary must hold.
      const poisons = [
        { garbage: true },
        { type: 'nope', requestId: 'req-storm-nope' },
        { type: 'job-event', jobId: 'not-a-uuid', organizationId: organization.id, requestId: 'x' },
      ]
      const poisonCount = 21
      const poisonIds = []
      for (let n = 0; n < poisonCount; n += 1) {
        const added = await queue.add('poison', poisons[n % poisons.length])
        poisonIds.push(added.id)
      }

      const goodAfter = await enqueueJobEvent(goodPayload('req-storm-after'))

      const beforeJob = await queue.getJob(goodBefore.id)
      const afterJob = await queue.getJob(goodAfter.id)
      const [beforeValue, afterValue] = await Promise.all([
        beforeJob.waitUntilFinished(events.queueEvents, 20_000),
        afterJob.waitUntilFinished(events.queueEvents, 20_000),
      ])
      expect(beforeValue).toMatchObject({ status: 'consumed', requestId: 'req-storm-before' })
      expect(afterValue).toMatchObject({ status: 'consumed', requestId: 'req-storm-after' })

      // Every poison failed fast exactly once (Unrecoverable, no retry storm)
      // instead of wedging the consumer.
      const failed = await queue.getFailed()
      expect(failed.map((entry) => entry.id)).toEqual(expect.arrayContaining(poisonIds))
      for (const entry of failed.filter((candidate) => poisonIds.includes(candidate.id))) {
        expect(entry.attemptsMade).toBe(1)
        expect(entry.failedReason).toMatch(/Unprocessable|No handler/)
      }

      const counts = await queue.getJobCounts('waiting', 'active', 'delayed')
      expect(counts.waiting).toBe(0)
      expect(counts.active).toBe(0)
    } finally {
      await closeQueueEvents(events)
      await stopWorker().catch(() => {})
    }
  })

  it('tolerates duplicate delivery of the same payload without corrupting state', async () => {
    await resetDatabase(ownerDatabase)
    await resetQueues()
    const { organization, job } = await createJobRow()
    const payload = jobEventPayload({
      jobId: job.id,
      organizationId: organization.id,
      requestId: `req-dup-${crypto.randomUUID()}`,
    })

    let events = null
    await startWorker({ prisma: ownerDatabase, reconciliation: false })
    try {
      events = await openQueueEvents(QUEUE_NAMES.jobEvents)
      const queue = getQueue(QUEUE_NAMES.jobEvents)

      // Same payload twice: what a redelivery after a crash looks like.
      const first = await enqueueJobEvent({ ...payload })
      const second = await enqueueJobEvent({ ...payload })

      const [firstValue, secondValue] = await Promise.all([
        (await queue.getJob(first.id)).waitUntilFinished(events.queueEvents, 20_000),
        (await queue.getJob(second.id)).waitUntilFinished(events.queueEvents, 20_000),
      ])

      expect(firstValue).toMatchObject({
        status: 'consumed',
        jobId: job.id,
        requestId: payload.requestId,
      })
      expect(secondValue).toEqual(firstValue)

      // No corruption: exactly one job row, fields untouched by the repeat.
      const rows = await ownerDatabase.job.findMany({ where: { id: job.id } })
      expect(rows).toHaveLength(1)
      expect(rows[0].title).toBe(job.title)
      expect(rows[0].status).toBe(job.status)
    } finally {
      await closeQueueEvents(events)
      await stopWorker().catch(() => {})
    }
  })
})
