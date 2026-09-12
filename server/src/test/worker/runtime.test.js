import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { QueueEvents, createNodeRedisClient } from 'bullmq'
import { createClient } from 'redis'
import { env } from '../../env.js'
import { QUEUE_NAMES, closeQueues, enqueueJobEvent, getQueue } from '../../lib/queue/index.js'
import { startWorker, stopWorker } from '../../worker.js'
import { createOwnerTestClient, resetDatabase } from '../helpers.js'

const workerEntryPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'worker.js',
)

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

async function waitForReturnvalue(queueEvents, jobId, timeoutMs = 15_000) {
  const queue = getQueue(QUEUE_NAMES.jobEvents)
  const deadline = Date.now() + timeoutMs
  let job = null
  while (!job && Date.now() < deadline) {
    job = await queue.getJob(jobId)
    if (!job) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!job) throw new Error(`job ${jobId} never appeared in the queue`)
  return job.waitUntilFinished(queueEvents, Math.max(1000, deadline - Date.now()))
}

describe('worker entrypoint', () => {
  it('boots with no HTTP listener', () => {
    const source = fs.readFileSync(workerEntryPath, 'utf8')

    expect(source).not.toMatch(/\.listen\s*\(/)
    expect(source).not.toMatch(/from 'express'/)
    expect(source).not.toMatch(/createServer/)
    expect(source).toMatch(/new Worker/)
    expect(source).toMatch(/SIGTERM/)
    expect(source).toMatch(/SIGINT/)
  })
})

describe('worker runtime', () => {
  let queueEvents
  let eventsRaw

  beforeAll(async () => {
    await resetDatabase(ownerDatabase)
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

  afterAll(async () => {
    await queueEvents?.close().catch(() => {})
    if (eventsRaw?.isOpen) await eventsRaw.quit().catch(() => {})
    await stopWorker().catch(() => {})
    await closeQueues()
    await ownerDatabase.$disconnect()
  })

  it('consumes an enqueued job-event and echoes the originating requestId', async () => {
    const payload = jobEventPayload({ requestId: 'req-runtime-1' })

    const enqueued = await enqueueJobEvent(payload)
    const returnvalue = await waitForReturnvalue(queueEvents, enqueued.id)

    expect(returnvalue).toMatchObject({ requestId: 'req-runtime-1' })
  })
})

describe('worker drain', () => {
  it('stopWorker finishes the current job instead of abandoning it', async () => {
    await resetDatabase(ownerDatabase)
    for (const name of Object.values(QUEUE_NAMES)) {
      await getQueue(name).obliterate({ force: true })
    }

    let releaseJob
    const gate = new Promise((resolve) => {
      releaseJob = resolve
    })
    const seen = []
    let processorResult
    await startWorker({
      prisma: ownerDatabase,
      reconciliation: false,
      processor: async (job) => {
        seen.push(job.id)
        await gate
        processorResult = { status: 'gated-done', requestId: job.data.requestId }
        return processorResult
      },
    })

    const enqueued = await enqueueJobEvent(jobEventPayload({ requestId: 'req-drain-1' }))

    // Wait until the worker picks the job up (it is now the "current" job).
    const deadline = Date.now() + 15_000
    for (;;) {
      const job = await getQueue(QUEUE_NAMES.jobEvents).getJob(enqueued.id)
      if (job && (await job.getState()) === 'active') break
      if (Date.now() > deadline) throw new Error('worker never picked up the gated job')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const stopping = stopWorker()
    // Let close() engage (stop fetching), then let the current job finish.
    await new Promise((resolve) => setTimeout(resolve, 500))
    releaseJob()
    await stopping

    const finished = await getQueue(QUEUE_NAMES.jobEvents).getJob(enqueued.id)
    expect(seen).toContain(enqueued.id)
    expect(await finished.getState()).toBe('completed')
    expect(processorResult).toMatchObject({ status: 'gated-done', requestId: 'req-drain-1' })
  })

  afterAll(async () => {
    await stopWorker().catch(() => {})
    await closeQueues()
    await ownerDatabase.$disconnect().catch(() => {})
  })
})
