import { UnrecoverableError } from 'bullmq'
import { logger } from '../../lib/logger.js'

// Shared parse/child-log/scoped-findFirst/noop skeleton for job-scoped queue
// consumers. Handlers pass only their literals (handler name, schema, messages,
// found outcome); validation failures are unrecoverable so poison fails fast.
export async function consumeJob(payload, deps = {}, { handler, schema, unprocessablePrefix, missingLog, found }) {
  let data
  try {
    data = schema.parse(payload)
  } catch (error) {
    throw new UnrecoverableError(`${unprocessablePrefix}: ${error.message}`)
  }
  const log = (deps.log ?? logger).child({
    handler,
    requestId: data.requestId,
    jobId: data.jobId,
    organizationId: data.organizationId,
  })

  const job = await deps.prisma.job.findFirst({
    where: { id: data.jobId, organizationId: data.organizationId },
  })

  if (!job) {
    log.info(missingLog)
    return { status: 'missing-job-noop', jobId: data.jobId, requestId: data.requestId }
  }

  return found(job, data, log)
}
