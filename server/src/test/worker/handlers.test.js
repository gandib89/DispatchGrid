import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { UnrecoverableError } from 'bullmq'
import { routeQueueJob } from '../../worker/handlers/index.js'
import { handleJobEvent } from '../../worker/handlers/job-event.js'
import { handleSlaCheck } from '../../worker/handlers/sla-check.js'
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
  it('re-reads PostgreSQL and finishes as a foundation no-op', async () => {
    const { organization, job } = await createJobRow()
    const log = recordingLogger()
    const payload = slaPayload({ jobId: job.id, organizationId: organization.id })

    const result = await handleSlaCheck(payload, { prisma: ownerDatabase, log })

    expect(result).toMatchObject({ status: 'sla-check-noop', jobId: job.id })
  })

  it('tolerates a missing job as a safe no-op', async () => {
    const result = await handleSlaCheck(slaPayload(), { prisma: ownerDatabase, log: recordingLogger() })

    expect(result).toMatchObject({ status: 'missing-job-noop' })
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
      { prisma: ownerDatabase, log: recordingLogger() },
    )

    expect(result).toMatchObject({ status: 'sla-check-noop', jobId: job.id })
  })
})
