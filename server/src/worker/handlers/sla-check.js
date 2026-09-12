import { z } from 'zod'
import { queueSchemas } from '../../../../shared/queue-schema.js'
import { logger } from '../../lib/logger.js'

const schemas = queueSchemas(z)

// Foundation no-op: parse at entry, re-read PostgreSQL, tolerate
// zero/one/many deliveries. Real threshold evaluation lands in B12.
export async function handleSlaCheck(payload, deps = {}) {
  const data = schemas.slaCheckPayloadSchema.parse(payload)
  const log = (deps.log ?? logger).child({
    handler: 'sla-check',
    requestId: data.requestId,
    jobId: data.jobId,
    organizationId: data.organizationId,
  })

  const job = await deps.prisma.job.findFirst({
    where: { id: data.jobId, organizationId: data.organizationId },
  })

  if (!job) {
    log.info('sla-check for unknown job; acknowledging as no-op')
    return { status: 'missing-job-noop', jobId: data.jobId, requestId: data.requestId }
  }

  log.info({ jobStatus: job.status, thresholdType: data.thresholdType }, 'SLA check observed')
  return { status: 'sla-check-noop', jobId: job.id, requestId: data.requestId }
}
