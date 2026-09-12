import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { UnrecoverableError } from 'bullmq'
import { handleNotification } from '../../worker/handlers/notifications.js'
import { routeQueueJob } from '../../worker/handlers/index.js'
import { reconcileNotifications } from '../../worker/reconcile.js'
import { startWorker, stopWorker } from '../../worker.js'
import {
  QUEUE_NAMES,
  closeQueues,
  enqueueNotification,
  getDeadLetterJobs,
  getQueue,
  notificationDefaults,
  notificationJobId,
} from '../../lib/queue/index.js'
import {
  createOrganizationFixture,
  createOwnerTestClient,
  createUserFixture,
  resetDatabase,
} from '../helpers.js'

// B13 proofs at the worker seam against real Postgres (+ real Redis where the
// pipeline itself is under test): one consequence per duplicate delivery,
// counted attempts with timestamps, business truth untouched by delivery
// failure, DLQ arrival after exhaustion, and a reconciliation sweep that
// repairs the post-commit enqueue gap.

const ownerDatabase = createOwnerTestClient()

function notificationPayload(overrides = {}) {
  return {
    type: 'notification',
    jobId: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    requestId: `req-notify-${crypto.randomUUID()}`,
    notificationType: 'JOB_ASSIGNED',
    recipientId: crypto.randomUUID(),
    ...overrides,
  }
}

function recordingLogger() {
  const entries = []
  const log = {
    entries,
    child(context) {
      entries.push({ childContext: context })
      return log
    },
    info(context, message) {
      entries.push({ context, message })
    },
  }
  return log
}

function explodingDatabase() {
  return {
    job: {
      findFirst() {
        throw new Error('database must not be touched before payload validation')
      },
    },
    notification: {
      findFirst() {
        throw new Error('database must not be touched before payload validation')
      },
    },
  }
}

async function createAssignedJob() {
  const organization = await createOrganizationFixture(ownerDatabase)
  const creator = await createUserFixture(ownerDatabase)
  const agent = await createUserFixture(ownerDatabase)
  const job = await ownerDatabase.job.create({
    data: {
      organizationId: organization.id,
      reference: `JOB-${crypto.randomUUID().slice(0, 8)}`,
      title: 'Notification fixture',
      latitude: 51.5,
      longitude: -0.12,
      status: 'ASSIGNED',
      currentAssigneeId: agent.id,
      createdById: creator.id,
      dueAt: new Date(Date.now() + 3_600_000),
    },
  })
  return { organization, creator, agent, job }
}

async function obliterateQueues() {
  for (const name of Object.values(QUEUE_NAMES)) {
    await getQueue(name).obliterate({ force: true })
  }
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

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
  await obliterateQueues().catch(() => {})
})

afterAll(async () => {
  await stopWorker().catch(() => {})
  await closeQueues().catch(() => {})
  await ownerDatabase.$disconnect().catch(() => {})
})

describe('notification handler', () => {
  it('rejects a malformed payload before any database code runs', async () => {
    await expect(
      handleNotification(
        { ...notificationPayload(), notificationType: 'NOPE' },
        { prisma: explodingDatabase(), log: recordingLogger() },
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it('tolerates a missing job as a safe no-op', async () => {
    const result = await handleNotification(notificationPayload(), {
      prisma: ownerDatabase,
      log: recordingLogger(),
    })

    expect(result).toMatchObject({ status: 'missing-job-noop' })
  })

  it('sends once and records a SENT consequence with timestamps', async () => {
    const { organization, agent, job } = await createAssignedJob()
    const sent = []
    const payload = notificationPayload({
      jobId: job.id,
      organizationId: organization.id,
      recipientId: agent.id,
    })

    const result = await handleNotification(payload, {
      prisma: ownerDatabase,
      log: recordingLogger(),
      sendNotification: async (message) => {
        sent.push(message)
      },
    })

    expect(result).toMatchObject({ status: 'notification-sent', attempts: 1 })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      jobId: job.id,
      notificationType: 'JOB_ASSIGNED',
      recipientId: agent.id,
      requestId: payload.requestId,
    })
    const row = await ownerDatabase.notification.findFirstOrThrow({
      where: { jobId: job.id, type: 'JOB_ASSIGNED', recipientId: agent.id },
    })
    expect(row).toMatchObject({ status: 'SENT', attempts: 1 })
    expect(row.lastAttemptAt).toBeInstanceOf(Date)
    expect(row.sentAt).toBeInstanceOf(Date)
  })

  it('delivers the same payload twice with one consequence and one send', async () => {
    const { organization, agent, job } = await createAssignedJob()
    let sends = 0
    const deps = {
      prisma: ownerDatabase,
      log: recordingLogger(),
      sendNotification: async () => {
        sends += 1
      },
    }
    const payload = notificationPayload({
      jobId: job.id,
      organizationId: organization.id,
      recipientId: agent.id,
    })

    const first = await handleNotification(payload, deps)
    const second = await handleNotification(payload, deps)

    expect(first).toMatchObject({ status: 'notification-sent' })
    expect(second).toMatchObject({ status: 'notification-already-sent', jobId: job.id })
    expect(sends).toBe(1)
    expect(
      await ownerDatabase.notification.count({
        where: { jobId: job.id, type: 'JOB_ASSIGNED', recipientId: agent.id },
      }),
    ).toBe(1)
  })

  it('counts a failed attempt without changing business truth', async () => {
    const { organization, agent, job } = await createAssignedJob()
    await ownerDatabase.assignment.create({
      data: {
        organizationId: organization.id,
        jobId: job.id,
        agentId: agent.id,
        state: 'OFFERED',
      },
    })
    await ownerDatabase.escalation.create({
      data: { organizationId: organization.id, jobId: job.id, threshold: 'BREACH' },
    })
    const payload = notificationPayload({
      jobId: job.id,
      organizationId: organization.id,
      notificationType: 'SLA_BREACH',
      recipientId: agent.id,
    })

    await expect(
      handleNotification(payload, {
        prisma: ownerDatabase,
        log: recordingLogger(),
        sendNotification: async () => {
          throw new Error('provider timeout')
        },
      }),
    ).rejects.toThrow('provider timeout')

    const row = await ownerDatabase.notification.findFirstOrThrow({
      where: { jobId: job.id, type: 'SLA_BREACH', recipientId: agent.id },
    })
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1 })
    expect(row.lastAttemptAt).toBeInstanceOf(Date)
    expect(row.sentAt).toBeNull()
    // Business truth stands: same status, same assignment, same escalation.
    await expect(
      ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({ status: 'ASSIGNED', version: job.version })
    expect(await ownerDatabase.assignment.count({ where: { jobId: job.id } })).toBe(1)
    expect(await ownerDatabase.escalation.count({ where: { jobId: job.id } })).toBe(1)
  })
})

describe('notification retry contract', () => {
  it('pins five attempts with 2s to 32s exponential backoff', () => {
    expect(notificationDefaults.attempts).toBe(5)
    expect(notificationDefaults.backoff).toMatchObject({ type: 'exponential', delay: 2000 })
  })

  it('exhausts retries into the dead-letter path with correlation intact', async () => {
    const { organization, agent, job } = await createAssignedJob()
    const requestId = `req-dlq-${crypto.randomUUID()}`
    const payload = notificationPayload({
      jobId: job.id,
      organizationId: organization.id,
      requestId,
      notificationType: 'SLA_BREACH',
      recipientId: agent.id,
    })

    await startWorker({
      prisma: ownerDatabase,
      reconciliation: false,
      processor: (bullJob) =>
        routeQueueJob(bullJob, {
          prisma: ownerDatabase,
          sendNotification: async () => {
            throw new Error('provider down')
          },
        }),
    })
    try {
      const enqueued = await enqueueNotification(payload, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 50 },
      })

      await waitUntil('notification exhaustion', async () => {
        const current = await getQueue(QUEUE_NAMES.notifications).getJob(enqueued.id)
        return (await current?.getState()) === 'failed' ? true : undefined
      })
      const match = await waitUntil('dead-letter arrival', async () => {
        const entries = await getDeadLetterJobs()
        return entries.find((entry) => entry.requestId === requestId)
      })

      expect(match).toMatchObject({
        sourceQueue: QUEUE_NAMES.notifications,
        requestId,
        attemptsMade: 3,
        failedReason: 'provider down',
      })
      expect(match.data).toMatchObject({ jobId: job.id, organizationId: organization.id })
      // Durable row stays retryable, never SENT; the job itself is untouched.
      const row = await ownerDatabase.notification.findFirstOrThrow({
        where: { jobId: job.id, type: 'SLA_BREACH', recipientId: agent.id },
      })
      expect(row.status).toBe('PENDING')
      expect(row.attempts).toBeGreaterThanOrEqual(1)
      await expect(
        ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } }),
      ).resolves.toMatchObject({ status: 'ASSIGNED' })
    } finally {
      await stopWorker().catch(() => {})
    }
  })
})

describe('notification reconciliation', () => {
  it('repairs committed work missing its delivery and leaves the rest alone', async () => {
    const { organization, agent, job } = await createAssignedJob()
    const breach = await ownerDatabase.escalation.create({
      data: { organizationId: organization.id, jobId: job.id, threshold: 'BREACH' },
    })
    await ownerDatabase.escalation.create({
      data: { organizationId: organization.id, jobId: job.id, threshold: 'WARNING' },
    })
    // Already-delivered work must not move.
    const delivered = await createAssignedJob()
    await ownerDatabase.notification.create({
      data: {
        organizationId: delivered.organization.id,
        jobId: delivered.job.id,
        type: 'JOB_ASSIGNED',
        recipientId: delivered.agent.id,
        status: 'SENT',
        attempts: 1,
        lastAttemptAt: new Date(),
        sentAt: new Date(),
      },
    })

    const result = await reconcileNotifications({ prisma: ownerDatabase })

    expect(result.requeued).toBe(2)
    const assigned = await getQueue(QUEUE_NAMES.notifications).getJob(
      notificationJobId(job.id, 'JOB_ASSIGNED', agent.id),
    )
    expect(assigned?.data).toMatchObject({
      jobId: job.id,
      notificationType: 'JOB_ASSIGNED',
      recipientId: agent.id,
    })
    const breached = await getQueue(QUEUE_NAMES.notifications).getJob(
      notificationJobId(job.id, 'SLA_BREACH', agent.id),
    )
    expect(breached?.data).toMatchObject({
      jobId: job.id,
      notificationType: 'SLA_BREACH',
      escalationId: breach.id,
    })
    // WARNING promises no delivery; delivered work is already complete.
    expect(
      await getQueue(QUEUE_NAMES.notifications).getJob(
        notificationJobId(job.id, 'SLA_WARNING', agent.id),
      ),
    ).toBeUndefined()
    expect(
      await getQueue(QUEUE_NAMES.notifications).getJob(
        notificationJobId(delivered.job.id, 'JOB_ASSIGNED', delivered.agent.id),
      ),
    ).toBeUndefined()
    // A second sweep collapses onto the pending deliveries: nothing new.
    const again = await reconcileNotifications({ prisma: ownerDatabase })
    expect(again).toMatchObject({ requeued: 0 })
  })
})
