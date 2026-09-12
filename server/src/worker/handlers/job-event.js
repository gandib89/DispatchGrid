import { z } from 'zod'
import { queueSchemas } from '../../../../shared/queue-schema.js'
import { logger } from '../../lib/logger.js'

const schemas = queueSchemas(z)

// At-least-once consumer: parse the payload at entry, re-read PostgreSQL
// (payload is a request, not truth), tolerate zero/one/many deliveries,
// return on success or throw for retry.
export async function handleJobEvent(payload, deps = {}) {
  const data = schemas.jobEventPayloadSchema.parse(payload)
  const log = (deps.log ?? logger).child({
    handler: 'job-event',
    requestId: data.requestId,
    jobId: data.jobId,
    organizationId: data.organizationId,
  })

  const job = await deps.prisma.job.findFirst({
    where: { id: data.jobId, organizationId: data.organizationId },
  })

  if (!job) {
    log.info('job-event for unknown job; acknowledging as no-op')
    return { status: 'missing-job-noop', jobId: data.jobId, requestId: data.requestId }
  }

  log.info({ jobStatus: job.status }, 'Consumed job event')
  return { status: 'consumed', jobId: job.id, requestId: data.requestId }
}
