import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { QueueEvents, createNodeRedisClient } from 'bullmq'
import { createClient } from 'redis'
import { env } from '../../env.js'
import { scheduleSlaAfterAssign } from '../../lib/integration-adapters.js'
import {
  QUEUE_NAMES,
  closeQueues,
  getQueue,
  removePendingSlaEvaluations,
  scheduleSlaCheck,
  slaCheckJobId,
} from '../../lib/queue/index.js'
import { startWorker, stopWorker } from '../../worker.js'
import { routeQueueJob } from '../../worker/handlers/index.js'
import { handleSlaCheck } from '../../worker/handlers/sla-check.js'
import {
  createOrganizationFixture,
  createOwnerTestClient,
  createUserFixture,
  resetDatabase,
} from '../helpers.js'

// Edge and failure proofs at the worker seam (B12-T5): everything #31–#34
// pinned in isolation, proven here under contention and death — simultaneous
// double delivery, terminal transitions before the threshold fires, a worker
// killed mid-escalation-transaction, a live offset-zero DG-4 firing, and
// policy-edit isolation through the actual fire. Real Redis + Postgres,
// near-future deadlines with short delays, no HTTP after scheduling.
const ownerDatabase = createOwnerTestClient()

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

function fakeHooks() {
  const published = []
  const enqueued = []
  return {
    published,
    enqueued,
    publishEscalationEvent: async (payload) => {
      published.push(payload)
    },
    enqueueEscalationNotification: async (payload) => {
      enqueued.push(payload)
    },
  }
}

async function createJobRow(dueAt = new Date(Date.now() + 3_600_000)) {
  const organization = await createOrganizationFixture(ownerDatabase)
  const user = await createUserFixture(ownerDatabase)
  const job = await ownerDatabase.job.create({
    data: {
      organizationId: organization.id,
      reference: `JOB-${crypto.randomUUID().slice(0, 8)}`,
      title: 'SLA edge fixture',
      latitude: 51.5,
      longitude: -0.12,
      createdById: user.id,
      dueAt,
    },
  })
  return { organization, user, job }
}

async function createPolicyRow(organization, overrides = {}) {
  return ownerDatabase.slaPolicy.create({
    data: {
      organizationId: organization.id,
      name: `Standard-${crypto.randomUUID().slice(0, 8)}`,
      warningMinutesBefore: 45,
      breachMinutesAfter: 10,
      ...overrides,
    },
  })
}

function slaPayload(job, organization, threshold, overrides = {}) {
  return {
    type: 'sla-check',
    jobId: job.id,
    organizationId: organization.id,
    requestId: `req-sla-edge-${crypto.randomUUID()}`,
    threshold,
    slaPolicyId: crypto.randomUUID(),
    warningMinutesBefore: 45,
    breachMinutesAfter: 10,
    dueAt: job.dueAt instanceof Date ? job.dueAt.toISOString() : job.dueAt,
    ...overrides,
  }
}

async function delayedForJob(jobId) {
  const delayed = await getQueue(QUEUE_NAMES.sla).getDelayed()
  return delayed.filter((entry) => entry?.data?.jobId === jobId)
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

async function waitUntil(description, fn, timeoutMs = 25_000) {
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
  for (const name of Object.values(QUEUE_NAMES)) {
    await getQueue(name).obliterate({ force: true })
  }
})

afterAll(async () => {
  await stopWorker().catch(() => {})
  await closeQueues()
  await ownerDatabase.$disconnect().catch(() => {})
})

describe('simultaneous double delivery', () => {
  it('two concurrent deliveries of one threshold yield exactly one escalation', async () => {
    const { organization, job } = await createJobRow()
    const hooks = fakeHooks()
    const payload = slaPayload(job, organization, 'BREACH')
    const deps = () => ({ prisma: ownerDatabase, log: recordingLogger(), ...hooks })

    // #34's duplicate proof is sequential; this is the true race: both
    // deliveries inside their transactions at once, decided by the
    // (jobId, threshold) uniqueness row, never by timing luck.
    const [first, second] = await Promise.all([
      handleSlaCheck(payload, deps()),
      handleSlaCheck(payload, deps()),
    ])

    expect([first.status, second.status].sort()).toEqual([
      'sla-escalated',
      'sla-escalation-complete',
    ])
    const rows = await ownerDatabase.escalation.findMany({ where: { jobId: job.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      jobId: job.id,
      organizationId: organization.id,
      threshold: 'BREACH',
    })
    // The loser acknowledged already-complete on the durable row, but the
    // P2002 path re-attempts breach side effects (at-least-once fan-out).
    expect(hooks.published).toHaveLength(2)
    expect(hooks.enqueued).toHaveLength(2)
  })
})

describe('terminal transition before the threshold fires', () => {
  it.each([['COMPLETED'], ['CANCELLED']])(
    '%s disarms the clock and a stale delivery is a no-op with no consequence',
    async (status) => {
      const { organization, user, job } = await createJobRow()
      await scheduleSlaCheck(slaPayload(job, organization, 'WARNING'), { delay: 60_000 })
      await scheduleSlaCheck(slaPayload(job, organization, 'BREACH'), { delay: 120_000 })
      expect(await delayedForJob(job.id)).toHaveLength(2)

      // The transition path disarms, exactly as the routes do on complete/cancel.
      await ownerDatabase.job.update({
        where: { id: job.id },
        data: {
          status,
          ...(status === 'COMPLETED'
            ? { currentAssigneeId: user.id, completedAt: new Date() }
            : {}),
        },
      })
      await expect(removePendingSlaEvaluations(job.id)).resolves.toEqual([true, true])
      expect(await delayedForJob(job.id)).toHaveLength(0)

      // And even if a stale timer survived removal, the handler re-reads
      // state: both thresholds no-op, nothing written, nothing fanned out.
      const hooks = fakeHooks()
      for (const threshold of ['WARNING', 'BREACH']) {
        const result = await handleSlaCheck(slaPayload(job, organization, threshold), {
          prisma: ownerDatabase,
          log: recordingLogger(),
          ...hooks,
        })
        expect(result).toMatchObject({ status: 'sla-terminal-noop', jobId: job.id })
      }
      expect(await ownerDatabase.escalation.count({ where: { jobId: job.id } })).toBe(0)
      const reloaded = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
      expect(reloaded.slaState).toBe('OK')
      expect(hooks.published).toHaveLength(0)
      expect(hooks.enqueued).toHaveLength(0)
    },
  )
})

describe('kill mid-escalation-transaction', () => {
  it('a crash before ack redelivers after restart to exactly one escalation', async () => {
    const { organization, job } = await createJobRow()
    const policy = await createPolicyRow(organization)
    const payload = slaPayload(job, organization, 'BREACH', { slaPolicyId: policy.id })
    const jobKey = slaCheckJobId(job.id, 'BREACH')

    // First delivery dies inside the transaction (retryable throw, never
    // returns); every later delivery runs the real router. Restarting the
    // worker between the two is the kill: the unacked escalation must come
    // back exactly once.
    let attempts = 0
    const processor = async (bullJob) => {
      attempts += 1
      if (attempts === 1) throw new Error('simulated crash mid-escalation-transaction')
      return routeQueueJob(bullJob, { prisma: ownerDatabase })
    }

    let events = null
    await startWorker({ prisma: ownerDatabase, processor })
    try {
      events = await openQueueEvents(QUEUE_NAMES.sla)
      await scheduleSlaCheck(payload, { delay: 500 })

      await waitUntil('first delivery attempt', () => (attempts >= 1 ? true : undefined))

      // Nothing was acked: the escalation must not be complete while dead.
      const midJob = await getQueue(QUEUE_NAMES.sla).getJob(jobKey)
      expect(await midJob.getState()).not.toBe('completed')

      // Kill (stop without ack) and restart: a new worker generation consumes.
      await stopWorker()
      await startWorker({ prisma: ownerDatabase, processor })

      const done = await waitUntil('redelivery completion', async () => {
        const current = await getQueue(QUEUE_NAMES.sla).getJob(jobKey)
        return (await current.getState()) === 'completed' ? current : undefined
      })

      // At-least-once may deliver more than twice (a backoff retry can
      // race the kill and die with the closing worker); the invariant is
      // the single durable escalation, not the attempt count.
      expect(attempts).toBeGreaterThanOrEqual(2)
      expect(done.returnvalue).toMatchObject({
        status: 'sla-escalated',
        jobId: job.id,
        threshold: 'BREACH',
        slaState: 'BREACHED',
      })
      await expect(
        ownerDatabase.escalation.count({ where: { jobId: job.id, threshold: 'BREACH' } }),
      ).resolves.toBe(1)
      const reloaded = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
      expect(reloaded.slaState).toBe('BREACHED')
    } finally {
      await closeQueueEvents(events)
      await stopWorker().catch(() => {})
    }
  })

  it('a rolled-back transaction throws for redelivery and the retry records one row', async () => {
    const { organization, job } = await createJobRow()
    const hooks = fakeHooks()
    const payload = slaPayload(job, organization, 'WARNING')
    const log = recordingLogger()

    // Fault injection at the seam: the write never commits (rollback), so the
    // throw is retryable and must leave zero rows behind.
    const dyingPrisma = {
      job: { findFirst: (args) => ownerDatabase.job.findFirst(args) },
      $transaction: () => Promise.reject(new Error('connection reset mid-transaction')),
    }
    await expect(handleSlaCheck(payload, { prisma: dyingPrisma, log })).rejects.toThrow(
      'connection reset mid-transaction',
    )
    expect(await ownerDatabase.escalation.count({ where: { jobId: job.id } })).toBe(0)

    // Redelivery after the kill converges to exactly one escalation.
    const result = await handleSlaCheck(payload, { prisma: ownerDatabase, log, ...hooks })
    expect(result).toMatchObject({ status: 'sla-escalated', threshold: 'WARNING' })
    await expect(
      ownerDatabase.escalation.count({ where: { jobId: job.id, threshold: 'WARNING' } }),
    ).resolves.toBe(1)
  })
})

describe('DG-4 live fire with offset zero', () => {
  it('a zero-offset policy armed at assign time breaches exactly at dueAt, no HTTP', async () => {
    const organization = await createOrganizationFixture(ownerDatabase)
    const user = await createUserFixture(ownerDatabase)
    await createPolicyRow(organization, { warningMinutesBefore: 0, breachMinutesAfter: 0 })
    const dueAt = new Date(Date.now() + 2_000)
    const job = await ownerDatabase.job.create({
      data: {
        organizationId: organization.id,
        reference: `JOB-${crypto.randomUUID().slice(0, 8)}`,
        title: 'SLA edge fixture',
        latitude: 51.5,
        longitude: -0.12,
        createdById: user.id,
        dueAt,
      },
    })

    const before = Date.now()
    const [warning, breach] = await scheduleSlaAfterAssign({
      job,
      organizationId: organization.id,
      requestId: `req-assign-${crypto.randomUUID()}`,
    })

    // Deterministic scheduling identities at the seam.
    expect(warning.id).toBe(slaCheckJobId(job.id, 'WARNING'))
    expect(breach.id).toBe(slaCheckJobId(job.id, 'BREACH'))
    // Offset zero: both fire exactly at dueAt, so both delays equal dueAt − now.
    const expected = dueAt.getTime() - before
    for (const entry of [warning, breach]) {
      expect(Math.abs(entry.opts.delay - expected)).toBeLessThan(1_500)
    }
    expect(Math.abs(warning.opts.delay - breach.opts.delay)).toBeLessThan(500)

    let events = null
    await startWorker({ prisma: ownerDatabase })
    try {
      events = await openQueueEvents(QUEUE_NAMES.sla)
      const queue = getQueue(QUEUE_NAMES.sla)
      const [warningValue, breachValue] = await Promise.all([
        (await queue.getJob(warning.id)).waitUntilFinished(events.queueEvents, 15_000),
        (await queue.getJob(breach.id)).waitUntilFinished(events.queueEvents, 15_000),
      ])
      expect(warningValue).toMatchObject({ status: 'sla-escalated', threshold: 'WARNING' })
      expect(breachValue).toMatchObject({
        status: 'sla-escalated',
        threshold: 'BREACH',
        slaState: 'BREACHED',
      })

      const reloaded = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
      expect(reloaded.slaState).toBe('BREACHED')
      await expect(
        ownerDatabase.escalation.count({ where: { jobId: job.id } }),
      ).resolves.toBe(2)

      // The breach did not fire early: it landed at dueAt, driven by time alone.
      const finished = await queue.getJob(breach.id)
      expect(finished.finishedOn).toBeGreaterThanOrEqual(dueAt.getTime() - 1_000)
      expect(Math.abs(finished.finishedOn - dueAt.getTime())).toBeLessThan(8_000)
    } finally {
      await closeQueueEvents(events)
      await stopWorker().catch(() => {})
    }
  })
})

describe('policy-edit isolation through the fire (A-6)', () => {
  it('an edited policy never shifts the armed job, which still fires on its frozen promise', async () => {
    const { organization, user, job: first } = await createJobRow(
      new Date(Date.now() + 7_200_000),
    )
    const policy = await createPolicyRow(organization)
    await scheduleSlaAfterAssign({
      job: first,
      organizationId: organization.id,
      requestId: `req-assign-${crypto.randomUUID()}`,
    })

    await ownerDatabase.slaPolicy.update({
      where: { id: policy.id },
      data: { warningMinutesBefore: 0, breachMinutesAfter: 0 },
    })

    // The armed evaluation keeps its frozen promise in the queue…
    const kept = await delayedForJob(first.id)
    expect(kept).toHaveLength(2)
    for (const entry of kept) {
      expect(entry.data).toMatchObject({ warningMinutesBefore: 45, breachMinutesAfter: 10 })
    }

    // …and still fires on it after the edit: the old promise is honored.
    const hooks = fakeHooks()
    const frozenWarning = kept.find((entry) => entry.data.threshold === 'WARNING')
    const result = await handleSlaCheck(
      { ...frozenWarning.data },
      { prisma: ownerDatabase, log: recordingLogger(), ...hooks },
    )
    expect(result).toMatchObject({ status: 'sla-escalated', threshold: 'WARNING' })
    const reloaded = await ownerDatabase.job.findUniqueOrThrow({ where: { id: first.id } })
    expect(reloaded.slaState).toBe('WARNING')

    // Newly assigned jobs see the edited policy.
    const second = await ownerDatabase.job.create({
      data: {
        organizationId: organization.id,
        reference: `JOB-${crypto.randomUUID().slice(0, 8)}`,
        title: 'SLA edge fixture',
        latitude: 51.5,
        longitude: -0.12,
        createdById: user.id,
        dueAt: new Date(Date.now() + 7_200_000),
      },
    })
    await scheduleSlaAfterAssign({
      job: second,
      organizationId: organization.id,
      requestId: `req-assign-${crypto.randomUUID()}`,
    })
    const rearmed = await delayedForJob(second.id)
    expect(rearmed).toHaveLength(2)
    for (const entry of rearmed) {
      expect(entry.data).toMatchObject({
        slaPolicyId: policy.id,
        warningMinutesBefore: 0,
        breachMinutesAfter: 0,
      })
    }
  })
})

describe('escalation audit history', () => {
  it('records one durable row per job and threshold, in threshold order', async () => {
    const { organization, job } = await createJobRow()
    const hooks = fakeHooks()
    const deps = { prisma: ownerDatabase, log: recordingLogger(), ...hooks }

    await handleSlaCheck(slaPayload(job, organization, 'WARNING'), deps)
    await handleSlaCheck(slaPayload(job, organization, 'BREACH'), deps)
    // A racing redelivery of the breach changes nothing.
    await Promise.all([
      handleSlaCheck(slaPayload(job, organization, 'BREACH'), deps),
      handleSlaCheck(slaPayload(job, organization, 'BREACH'), deps),
    ])

    const rows = await ownerDatabase.escalation.findMany({
      where: { jobId: job.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    expect(rows.map((row) => row.threshold)).toEqual(['WARNING', 'BREACH'])
    for (const row of rows) {
      expect(row).toMatchObject({ organizationId: organization.id, jobId: job.id })
      expect(typeof row.id).toBe('string')
      expect(row.createdAt).toBeInstanceOf(Date)
    }
  })
})
