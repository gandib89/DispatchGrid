import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { UnrecoverableError } from 'bullmq'
import { routeQueueJob } from '../../worker/handlers/index.js'
import { handleJobEvent } from '../../worker/handlers/job-event.js'
import { handleSlaCheck } from '../../worker/handlers/sla-check.js'
import { productionDeps } from '../../worker.js'
import { integrationAdapters } from '../../lib/integration-adapters.js'
import {
  createOwnerTestClient,
  createOrganizationFixture,
  createUserFixture,
  resetDatabase,
} from '../helpers.js'

const ownerDatabase = createOwnerTestClient()

function jobEventPayload(overrides = {}) {
  return {
    type: 'job-event',
    jobId: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    requestId: `req-${crypto.randomUUID()}`,
    ...overrides,
  }
}

function slaPayload(overrides = {}) {
  return {
    type: 'sla-check',
    jobId: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    requestId: `req-${crypto.randomUUID()}`,
    threshold: 'WARNING',
    slaPolicyId: crypto.randomUUID(),
    warningMinutesBefore: 30,
    breachMinutesAfter: 15,
    dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  }
}

function explodingDatabase() {
  return {
    job: {
      findFirst() {
        throw new Error('database must not be touched before payload validation')
      },
    },
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

async function createJobRow() {
  const organization = await createOrganizationFixture(ownerDatabase)
  const user = await createUserFixture(ownerDatabase)
  const job = await ownerDatabase.job.create({
    data: {
      organizationId: organization.id,
      reference: `JOB-${crypto.randomUUID().slice(0, 8)}`,
      title: 'Handler fixture',
      latitude: 51.5,
      longitude: -0.12,
      createdById: user.id,
      dueAt: new Date(Date.now() + 3_600_000),
    },
  })
  return { organization, job }
}

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
})

afterAll(async () => {
  await ownerDatabase.$disconnect()
})

describe('handler entry validation', () => {
  it('rejects a malformed job-event before any database code runs', async () => {
    await expect(
      handleJobEvent({ ...jobEventPayload(), requestId: undefined }, { prisma: explodingDatabase() }),
    ).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it('rejects a malformed sla-check before any database code runs', async () => {
    await expect(
      handleSlaCheck({ ...slaPayload(), jobId: 'not-a-uuid' }, { prisma: explodingDatabase() }),
    ).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it('rejects unknown payload types at the router before any database code runs', async () => {
    await expect(
      routeQueueJob({ data: { type: 'nope', requestId: 'req-1' } }, { prisma: explodingDatabase() }),
    ).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it('fails malformed router payloads without retry (poison fails loudly)', async () => {
    await expect(
      routeQueueJob({ data: { garbage: true } }, { prisma: explodingDatabase() }),
    ).rejects.toBeInstanceOf(UnrecoverableError)
  })
})

describe('job-event handler', () => {
  it('consumes an existing job and logs the originating requestId', async () => {
    const { organization, job } = await createJobRow()
    const log = recordingLogger()
    const payload = jobEventPayload({
      jobId: job.id,
      organizationId: organization.id,
      requestId: 'req-correlation-1',
    })

    const result = await handleJobEvent(payload, { prisma: ownerDatabase, log })

    expect(result).toMatchObject({ status: 'consumed', jobId: job.id, requestId: 'req-correlation-1' })
    expect(log.entries.some((entry) => entry.childContext?.requestId === 'req-correlation-1')).toBe(true)
  })

  it('tolerates zero deliveries: a missing job is a safe no-op, not a retry', async () => {
    const log = recordingLogger()
    const result = await handleJobEvent(jobEventPayload(), { prisma: ownerDatabase, log })

    expect(result).toMatchObject({ status: 'missing-job-noop' })
  })

  it('tolerates many deliveries: repeat consumption returns the same outcome', async () => {
    const { organization, job } = await createJobRow()
    const log = recordingLogger()
    const payload = jobEventPayload({ jobId: job.id, organizationId: organization.id })

    const first = await handleJobEvent(payload, { prisma: ownerDatabase, log })
    const second = await handleJobEvent(payload, { prisma: ownerDatabase, log })

    expect(second).toEqual(first)
  })
})

describe('sla-check handler', () => {
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

  function payloadFor(job, organization, threshold, hooks, overrides = {}) {
    return slaPayload({
      jobId: job.id,
      organizationId: organization.id,
      threshold,
      ...overrides,
    })
  }

  async function depsWith(hooks) {
    return { prisma: ownerDatabase, log: recordingLogger(), ...hooks }
  }

  it('warning delivery sets WARNING and records one escalation with no HTTP', async () => {
    const { organization, job } = await createJobRow()
    const hooks = fakeHooks()
    const payload = payloadFor(job, organization, 'WARNING', hooks)

    const result = await handleSlaCheck(payload, await depsWith(hooks))

    expect(result).toMatchObject({ status: 'sla-escalated', jobId: job.id, threshold: 'WARNING', slaState: 'WARNING' })
    const reloaded = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(reloaded.slaState).toBe('WARNING')
    const rows = await ownerDatabase.escalation.findMany({ where: { jobId: job.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ threshold: 'WARNING', organizationId: organization.id })
    // Warning alone fans out nothing: notification + publish are breach-only.
    expect(hooks.published).toHaveLength(0)
    expect(hooks.enqueued).toHaveLength(0)
  })

  it('breach delivery sets BREACHED, records one escalation, then enqueues and publishes', async () => {
    const { organization, job } = await createJobRow()
    const hooks = fakeHooks()
    const payload = payloadFor(job, organization, 'BREACH', hooks)

    const result = await handleSlaCheck(payload, await depsWith(hooks))

    expect(result).toMatchObject({ status: 'sla-escalated', jobId: job.id, threshold: 'BREACH', slaState: 'BREACHED' })
    const reloaded = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(reloaded.slaState).toBe('BREACHED')
    const rows = await ownerDatabase.escalation.findMany({ where: { jobId: job.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ threshold: 'BREACH' })
    expect(hooks.published).toHaveLength(1)
    expect(hooks.published[0]).toMatchObject({
      jobId: job.id,
      organizationId: organization.id,
      escalationId: rows[0].id,
      threshold: 'BREACH',
    })
    expect(hooks.enqueued).toHaveLength(1)
    expect(hooks.enqueued[0]).toMatchObject({ jobId: job.id, organizationId: organization.id })
  })

  it('duplicate deliveries of the same threshold create exactly one row and acknowledge as complete', async () => {
    const { organization, job } = await createJobRow()
    const hooks = fakeHooks()
    const payload = payloadFor(job, organization, 'BREACH', hooks)
    const deps = await depsWith(hooks)

    const first = await handleSlaCheck(payload, deps)
    const second = await handleSlaCheck(payload, deps)

    expect(first.status).toBe('sla-escalated')
    expect(second).toMatchObject({
      status: 'sla-escalation-complete',
      jobId: job.id,
      threshold: 'BREACH',
    })
    expect(await ownerDatabase.escalation.count({ where: { jobId: job.id, threshold: 'BREACH' } })).toBe(1)
    // The redelivery is already-complete on the durable row, but the P2002
    // path re-attempts breach side effects: a retry after a post-commit
    // fan-out death is how lost side effects converge (at-least-once fan-out).
    expect(hooks.published).toHaveLength(2)
    expect(hooks.enqueued).toHaveLength(2)
  })

  it.each([['COMPLETED'], ['CANCELLED'], ['FAILED']])(
    'terminal %s jobs are a safe no-op with no write and no side effects',
    async (status) => {
      const organization = await createOrganizationFixture(ownerDatabase)
      const user = await createUserFixture(ownerDatabase)
      const job = await ownerDatabase.job.create({
        data: {
          organizationId: organization.id,
          reference: `JOB-${crypto.randomUUID().slice(0, 8)}`,
          title: 'Handler fixture',
          latitude: 51.5,
          longitude: -0.12,
          createdById: user.id,
          dueAt: new Date(Date.now() + 3_600_000),
          status,
          // COMPLETED/FAILED rows must carry an assignee per the status check.
          ...(['COMPLETED', 'FAILED'].includes(status) ? { currentAssigneeId: user.id } : {}),
          ...(status === 'COMPLETED' ? { completedAt: new Date() } : {}),
        },
      })
      const hooks = fakeHooks()

      const result = await handleSlaCheck(
        payloadFor(job, organization, 'BREACH', hooks),
        await depsWith(hooks),
      )

      expect(result).toMatchObject({ status: 'sla-terminal-noop', jobId: job.id })
      expect(await ownerDatabase.escalation.count({ where: { jobId: job.id } })).toBe(0)
      const reloaded = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
      expect(reloaded.slaState).toBe('OK')
      expect(hooks.published).toHaveLength(0)
      expect(hooks.enqueued).toHaveLength(0)
    },
  )

  it('a breach without a prior warning still converges the job to BREACHED', async () => {
    const { organization, job } = await createJobRow()
    const hooks = fakeHooks()

    await handleSlaCheck(payloadFor(job, organization, 'BREACH', hooks), await depsWith(hooks))

    const reloaded = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(reloaded.slaState).toBe('BREACHED')
  })

  it('warning after breach keeps BREACHED but still records the warning row', async () => {
    const { organization, job } = await createJobRow()
    const hooks = fakeHooks()
    const deps = await depsWith(hooks)

    await handleSlaCheck(payloadFor(job, organization, 'BREACH', hooks), deps)
    const result = await handleSlaCheck(payloadFor(job, organization, 'WARNING', hooks), deps)

    expect(result).toMatchObject({ status: 'sla-escalated', threshold: 'WARNING', slaState: 'BREACHED' })
    const reloaded = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(reloaded.slaState).toBe('BREACHED')
    expect(await ownerDatabase.escalation.count({ where: { jobId: job.id } })).toBe(2)
  })

  it('a genuine transaction failure throws for redelivery instead of acknowledging', async () => {
    const { organization, job } = await createJobRow()
    const failingPrisma = {
      job: { findFirst: () => ownerDatabase.job.findFirst({ where: { id: job.id } }) },
      $transaction: () => Promise.reject(new Error('connection reset')),
    }
    const payload = slaPayload({ jobId: job.id, organizationId: organization.id, threshold: 'WARNING' })

    await expect(handleSlaCheck(payload, { prisma: failingPrisma, log: recordingLogger() })).rejects.toThrow(
      'connection reset',
    )
    expect(await ownerDatabase.escalation.count({ where: { jobId: job.id } })).toBe(0)
  })

  it('tolerates a missing job as a safe no-op', async () => {
    const result = await handleSlaCheck(slaPayload(), { prisma: ownerDatabase, log: recordingLogger() })

    expect(result).toMatchObject({ status: 'missing-job-noop' })
  })

  it('a foreign organizationId is a missing-job no-op with zero writes', async () => {
    const { job } = await createJobRow()
    const hooks = fakeHooks()
    const payload = slaPayload({
      jobId: job.id,
      organizationId: crypto.randomUUID(),
      threshold: 'BREACH',
    })

    const result = await handleSlaCheck(payload, await depsWith(hooks))

    expect(result).toMatchObject({ status: 'missing-job-noop', jobId: job.id })
    expect(await ownerDatabase.escalation.count({ where: { jobId: job.id } })).toBe(0)
    const reloaded = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(reloaded.slaState).toBe('OK')
    expect(hooks.published).toHaveLength(0)
    expect(hooks.enqueued).toHaveLength(0)
  })

  it('a pre-B12 payload without thresholds is an acknowledged no-op', async () => {
    const { organization, job } = await createJobRow()
    const legacy = {
      type: 'sla-check',
      jobId: job.id,
      organizationId: organization.id,
      requestId: `req-legacy-${crypto.randomUUID()}`,
    }

    const result = await handleSlaCheck(legacy, { prisma: ownerDatabase, log: recordingLogger() })

    expect(result).toMatchObject({ status: 'sla-legacy-noop', jobId: job.id })
    expect(await ownerDatabase.escalation.count({ where: { jobId: job.id } })).toBe(0)
    const reloaded = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(reloaded.slaState).toBe('OK')
  })

  it('a breach retry landing on the duplicate path still publishes and enqueues', async () => {
    const { organization, job } = await createJobRow()
    const payload = slaPayload({ jobId: job.id, organizationId: organization.id, threshold: 'BREACH' })

    // First delivery commits the escalation row, then dies before side effects.
    const dyingDeps = {
      prisma: ownerDatabase,
      log: recordingLogger(),
      publishEscalationEvent: async () => {
        throw new Error('fan-out died post-commit')
      },
      enqueueEscalationNotification: async () => {
        throw new Error('unreached')
      },
    }
    await expect(handleSlaCheck(payload, dyingDeps)).rejects.toThrow('fan-out died post-commit')
    expect(await ownerDatabase.escalation.count({ where: { jobId: job.id, threshold: 'BREACH' } })).toBe(1)

    // The retry hits P2002 already-complete: side effects still run, once.
    const hooks = fakeHooks()
    const retry = await handleSlaCheck(payload, await depsWith(hooks))

    expect(retry).toMatchObject({ status: 'sla-escalation-complete', jobId: job.id, threshold: 'BREACH' })
    expect(await ownerDatabase.escalation.count({ where: { jobId: job.id, threshold: 'BREACH' } })).toBe(1)
    expect(hooks.published).toHaveLength(1)
    const row = await ownerDatabase.escalation.findFirstOrThrow({
      where: { jobId: job.id, threshold: 'BREACH' },
    })
    expect(hooks.published[0]).toMatchObject({
      jobId: job.id,
      organizationId: organization.id,
      escalationId: row.id,
      threshold: 'BREACH',
    })
    expect(hooks.enqueued).toHaveLength(1)
    expect(hooks.enqueued[0]).toMatchObject({ jobId: job.id, organizationId: organization.id })
  })
})

describe('handler router', () => {
  it('dispatches job-event payloads to the job handler', async () => {
    const { organization, job } = await createJobRow()
    const result = await routeQueueJob(
      { data: jobEventPayload({ jobId: job.id, organizationId: organization.id }) },
      { prisma: ownerDatabase, log: recordingLogger() },
    )

    expect(result).toMatchObject({ status: 'consumed', jobId: job.id })
  })

  it('dispatches sla-check payloads to the sla handler', async () => {
    const { organization, job } = await createJobRow()
    const result = await routeQueueJob(
      { data: slaPayload({ jobId: job.id, organizationId: organization.id }) },
      {
        prisma: ownerDatabase,
        log: recordingLogger(),
        publishEscalationEvent: async () => {},
        enqueueEscalationNotification: async () => {},
      },
    )

    expect(result).toMatchObject({ status: 'sla-escalated', jobId: job.id })
  })

  it('routes legacy pre-B12 payloads to an acknowledged no-op instead of poison', async () => {
    const { organization, job } = await createJobRow()
    const result = await routeQueueJob(
      {
        data: {
          type: 'sla-check',
          jobId: job.id,
          organizationId: organization.id,
          requestId: `req-legacy-${crypto.randomUUID()}`,
        },
      },
      { prisma: ownerDatabase, log: recordingLogger() },
    )

    expect(result).toMatchObject({ status: 'sla-legacy-noop', jobId: job.id })
    expect(await ownerDatabase.escalation.count({ where: { jobId: job.id } })).toBe(0)
  })

  it('production deps fan a breach out through both escalation seams', async () => {
    const { organization, job } = await createJobRow()
    const published = []
    const enqueued = []
    const originalPublish = integrationAdapters.publishEscalationEvent
    const originalEnqueue = integrationAdapters.enqueueEscalationNotification
    integrationAdapters.publishEscalationEvent = async (payload) => {
      published.push(payload)
    }
    integrationAdapters.enqueueEscalationNotification = async (payload) => {
      enqueued.push(payload)
    }
    try {
      const result = await routeQueueJob(
        { data: slaPayload({ jobId: job.id, organizationId: organization.id, threshold: 'BREACH' }) },
        productionDeps(ownerDatabase),
      )

      expect(result).toMatchObject({ status: 'sla-escalated', jobId: job.id, threshold: 'BREACH' })
      expect(published).toHaveLength(1)
      expect(published[0]).toMatchObject({
        jobId: job.id,
        organizationId: organization.id,
        threshold: 'BREACH',
      })
      expect(enqueued).toHaveLength(1)
      expect(enqueued[0]).toMatchObject({ jobId: job.id, organizationId: organization.id })
    } finally {
      integrationAdapters.publishEscalationEvent = originalPublish
      integrationAdapters.enqueueEscalationNotification = originalEnqueue
    }
  })
})
