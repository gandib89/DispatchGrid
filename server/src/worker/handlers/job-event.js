import { z } from 'zod'
import { queueSchemas } from '../../../../shared/queue-schema.js'
import { consumeJob } from './consume-job.js'

const schemas = queueSchemas(z)

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
    onJobFound: (job, data, log) => {
      log.info({ jobStatus: job.status }, 'Consumed job event')
      return { status: 'consumed', jobId: job.id, requestId: data.requestId }
    },
  })
}
