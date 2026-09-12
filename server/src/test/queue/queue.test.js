import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { queueSchemas } from '../../../../shared/queue-schema.js'
import {
  QUEUE_NAMES,
  closeQueues,
  enqueueJobEvent,
  getQueue,
  queueDefaults,
  scheduleSlaCheck,
} from '../../lib/queue/index.js'

const schemas = queueSchemas(z)

function jobEventPayload(overrides = {}) {
  return {
    type: 'job-event',
    jobId: crypto.randomUUID(),
    jobVersion: 0,
    organizationId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    ...overrides,
  }
}

function slaPayload(overrides = {}) {
  return {
    type: 'sla-check',
    jobId: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    threshold: 'WARNING',
    slaPolicyId: crypto.randomUUID(),
    warningMinutesBefore: 30,
    breachMinutesAfter: 15,
    dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  }
}

beforeEach(async () => {
  for (const name of Object.values(QUEUE_NAMES)) {
    await getQueue(name).obliterate({ force: true })
  }
})

afterAll(async () => {
  await closeQueues()
})

describe('queue payload contracts', () => {
  it('accepts a minimal job-event payload at the boundary', () => {
    expect(() => schemas.queuePayloadSchema.parse(jobEventPayload())).not.toThrow()
  })

  it('accepts an sla-check payload at the boundary', () => {
    expect(() => schemas.queuePayloadSchema.parse(slaPayload())).not.toThrow()
  })

  it('rejects payloads missing IDs, organization ID, type, or request ID', () => {
    for (const payload of [
      { ...jobEventPayload(), jobId: undefined },
      { ...jobEventPayload(), jobVersion: undefined },
      { ...jobEventPayload(), organizationId: undefined },
      { ...jobEventPayload(), requestId: undefined },
      { ...jobEventPayload(), type: undefined },
      { ...slaPayload(), threshold: 'someday' },
    ]) {
      expect(() => schemas.queuePayloadSchema.parse(payload)).toThrow()
    }
  })

  it('rejects unknown fields and whole-record shapes', () => {
    expect(() => schemas.queuePayloadSchema.parse(jobEventPayload({ extra: 'nope' }))).toThrow()
    expect(
      () =>
        schemas.queuePayloadSchema.parse(
          jobEventPayload({ job: { id: crypto.randomUUID(), title: 'entire ORM record' } }),
        ),
    ).toThrow()
  })
})

describe('centralized queue module', () => {
  it('exposes the named queues with shared retry/backoff defaults', () => {
    expect(QUEUE_NAMES).toEqual(
      expect.objectContaining({ jobEvents: 'job-events', sla: 'sla', deadLetter: 'dead-letter' }),
    )
    expect(queueDefaults.attempts).toBeGreaterThan(1)
    expect(queueDefaults.backoff).toEqual(
      expect.objectContaining({ type: 'exponential', delay: expect.any(Number) }),
    )
    for (const name of Object.values(QUEUE_NAMES)) {
      expect(getQueue(name).name).toBe(name)
    }
    expect(() => getQueue('no-such-queue')).toThrow()
  })

  it('round-trips a validated job-event against real Redis', async () => {
    const payload = jobEventPayload()

    const job = await enqueueJobEvent(payload)

    expect(job.id).toEqual(expect.any(String))
    const stored = await getQueue(QUEUE_NAMES.jobEvents).getJob(job.id)
    expect(stored?.data).toEqual(payload)
  })

  it('schedules a delayed SLA check against real Redis', async () => {
    const payload = slaPayload()

    const job = await scheduleSlaCheck(payload, { delay: 60_000 })

    const delayed = await getQueue(QUEUE_NAMES.sla).getDelayed()
    expect(delayed.map((entry) => entry.id)).toContain(job.id)
    expect((await getQueue(QUEUE_NAMES.sla).getJob(job.id))?.data).toEqual(payload)
  })

  it('rejects malformed payloads before anything reaches Redis', async () => {
    const queue = getQueue(QUEUE_NAMES.jobEvents)

    await expect(enqueueJobEvent({ ...jobEventPayload(), requestId: undefined })).rejects.toThrow()
    await expect(scheduleSlaCheck({ ...slaPayload(), jobId: 'not-a-uuid' })).rejects.toThrow()

    expect(await queue.getJobCounts('waiting', 'delayed')).toEqual(
      expect.objectContaining({ waiting: 0, delayed: 0 }),
    )
  })
})
