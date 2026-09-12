import { z } from 'zod'
import { queueSchemas } from '../../../../shared/queue-schema.js'
import { consumeJob } from './consume-job.js'

const schemas = queueSchemas(z)

// Foundation no-op: parse at entry, re-read PostgreSQL, tolerate
// zero/one/many deliveries. Threshold vocabulary and evaluation land in B12.
// Validation failures are unrecoverable so poison fails fast (see job-event).
export async function handleSlaCheck(payload, deps = {}) {
  return consumeJob(payload, deps, {
    handler: 'sla-check',
    schema: schemas.slaCheckPayloadSchema,
    unprocessablePrefix: 'Unprocessable sla-check payload',
    missingLog: 'sla-check for unknown job; acknowledging as no-op',
    found: (job, data, log) => {
      log.info({ jobStatus: job.status }, 'SLA check observed')
      return { status: 'sla-check-noop', jobId: job.id, requestId: data.requestId }
    },
  })
}
