import { z } from 'zod'
import { queueSchemas } from '../../../../shared/queue-schema.js'
import { enqueueNotification } from '../../lib/queue/index.js'
import { consumeJob } from './consume-job.js'

const schemas = queueSchemas(z)

// Delivery routing lives here — outside the Jobs and SLA modules. A consumed
// job event becomes one delivery request for the agent holding the job, or
// its creator while unassigned. Repeats are harmless downstream: re-enqueues
// collapse onto the pending delivery by deterministic queue id, and a prior
// SENT record turns redelivery into a no-op.
export function resolveNotificationTarget(job) {
  const recipientId = job.currentAssigneeId ?? job.createdById
  switch (job.status) {
    case 'ASSIGNED':
      return { notificationType: 'JOB_ASSIGNED', recipientId }
    case 'COMPLETED':
      return { notificationType: 'JOB_COMPLETED', recipientId }
    default:
      return { notificationType: 'JOB_UPDATED', recipientId }
  }
}

// At-least-once consumer: parse the payload at entry, re-read PostgreSQL
// (payload is a request, not truth), tolerate zero/one/many deliveries,
// return on success or throw for retry. Validation failures are
// unrecoverable: poison must fail loudly without retry, never wedge the
// consumer re-running backoff loops.
export async function handleJobEvent(payload, deps = {}) {
  return consumeJob(payload, deps, {
    handler: 'job-event',
    schema: schemas.jobEventPayloadSchema,
    unprocessablePrefix: 'Unprocessable job-event payload',
    missingLog: 'job-event for unknown job; acknowledging as no-op',
    onJobFound: async (job, data, log) => {
      log.info({ jobStatus: job.status }, 'Consumed job event')
      const enqueue = deps.enqueueNotification ?? enqueueNotification
      const target = resolveNotificationTarget(job)
      await enqueue({
        type: 'notification',
        jobId: job.id,
        organizationId: job.organizationId,
        requestId: data.requestId,
        ...target,
      })
      return { status: 'consumed', jobId: job.id, requestId: data.requestId, ...target }
    },
  })
}
