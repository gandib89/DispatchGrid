import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { QueueEvents, createNodeRedisClient } from 'bullmq'
import { createClient } from 'redis'
import { env } from '../../env.js'
import { QUEUE_NAMES, closeQueues, getQueue, scheduleSlaCheck } from '../../lib/queue/index.js'
import { startWorker, stopWorker } from '../../worker.js'
import {
  createOrganizationFixture,
  createOwnerTestClient,
  createUserFixture,
  resetDatabase,
} from '../helpers.js'

// Queue seam (B11): scheduleSlaCheck enqueues with the intended delay and the
// worker consumes it after the delay. No route wiring — threshold evaluation
// and route scheduling land in B12.
const ownerDatabase = createOwnerTestClient()

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
  for (const name of Object.values(QUEUE_NAMES)) {
    await getQueue(name).obliterate({ force: true })
  }
})

afterAll(async () => {
  await stopWorker().catch(() => {})
  await closeQueues()
  await ownerDatabase.$disconnect().catch(() => {})
})

describe('delayed sla-check seam', () => {
  it('enqueues with delay and the worker consumes it after the delay', async () => {
    const organization = await createOrganizationFixture(ownerDatabase)
    const user = await createUserFixture(ownerDatabase)
    const job = await ownerDatabase.job.create({
      data: {
        organizationId: organization.id,
        reference: `JOB-${crypto.randomUUID().slice(0, 8)}`,
        title: 'SLA delay fixture',
        latitude: 51.5,
        longitude: -0.12,
        createdById: user.id,
        dueAt: new Date(Date.now() + 3_600_000),
      },
    })
    const payload = {
      type: 'sla-check',
      jobId: job.id,
      organizationId: organization.id,
      requestId: `req-sla-${crypto.randomUUID()}`,
    }

    await startWorker({ prisma: ownerDatabase, reconciliation: false })
    const raw = createClient({ url: env.REDIS_URL })
    const queueEvents = new QueueEvents(QUEUE_NAMES.sla, {
      connection: createNodeRedisClient(raw),
    })
    await queueEvents.waitUntilReady()
    try {
      const enqueued = await scheduleSlaCheck(payload, { delay: 1000 })

      // Enqueued with the intended delay.
      expect(enqueued.opts?.delay).toBe(1000)
      const delayed = await getQueue(QUEUE_NAMES.sla).getDelayed()
      expect(delayed.map((entry) => entry.id)).toContain(enqueued.id)

      // The worker consumes it after the delay.
      const stored = await getQueue(QUEUE_NAMES.sla).getJob(enqueued.id)
      const returnvalue = await stored.waitUntilFinished(queueEvents, 15_000)
      expect(returnvalue).toMatchObject({
        status: 'sla-check-noop',
        jobId: job.id,
        requestId: payload.requestId,
      })
      const finished = await getQueue(QUEUE_NAMES.sla).getJob(enqueued.id)
      expect(finished.finishedOn - finished.timestamp).toBeGreaterThanOrEqual(800)
    } finally {
      await queueEvents.close().catch(() => {})
      if (raw?.isOpen) await raw.quit().catch(() => {})
      await stopWorker().catch(() => {})
    }
  })
})
