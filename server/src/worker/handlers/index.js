import { UnrecoverableError } from 'bullmq'
import { z } from 'zod'
import { queueSchemas } from '../../../../shared/queue-schema.js'
import { handleJobEvent } from './job-event.js'
import { handleSlaCheck, isLegacySlaCheck } from './sla-check.js'
import { handleNotification } from './notifications.js'

const schemas = queueSchemas(z)

export const queueHandlers = Object.freeze({
  'job-event': handleJobEvent,
  'sla-check': handleSlaCheck,
  notification: handleNotification,
})

// Handler router: validate every payload at entry, dispatch by type.
// Malformed payloads fail loudly without retry (poison is for the T5
// dead-letter path to inspect, not to redeliver); unexpected handler errors
// propagate so BullMQ retries per the job's attempts/backoff.
export async function routeQueueJob(job, deps) {
  let payload
  try {
    payload = schemas.queuePayloadSchema.parse(job?.data)
  } catch (error) {
    // Pre-B12 (B11) delayed timers carry no threshold promise and fail strict
    // parsing: the sla-check handler acknowledges them instead of poisoning.
    if (isLegacySlaCheck(job?.data)) {
      return handleSlaCheck(job.data, deps)
    }
    throw new UnrecoverableError(`Unprocessable queue payload: ${error.message}`)
  }

  const handler = queueHandlers[payload.type]
  if (!handler) {
    throw new UnrecoverableError(`No handler for queue payload type: ${payload.type}`)
  }

  return handler(payload, deps)
}
