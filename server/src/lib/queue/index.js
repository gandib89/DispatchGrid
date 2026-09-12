import { Queue } from 'bullmq'
import { z } from 'zod'
import { queueSchemas } from '../../../../shared/queue-schema.js'
import { logger } from '../logger.js'
import { createRedisClient } from '../redis.js'

// Centralized queue module (B11-T1). Single owner of Redis/BullMQ connection
// creation, named queues, shared retry/backoff defaults, and producer helpers.
// Producer helpers run ONLY after commit with plain validated data: they take
// no transaction, no Prisma client, and no ORM records. Never import this from
// services or transactions — nothing may enqueue inside a transaction.
// No business logic lives here: payloads are validated at this boundary and
// consumers re-read PostgreSQL (payload = request, not truth).

const schemas = queueSchemas(z)

export const QUEUE_NAMES = Object.freeze({
  jobEvents: 'job-events',
  sla: 'sla',
  deadLetter: 'dead-letter',
})

// Failed jobs stay in the failed set by default so the dead-letter path (T5)
// has something to inspect; completed jobs are capped to bound Redis memory.
export const queueDefaults = Object.freeze({
  attempts: 5,
  backoff: Object.freeze({ type: 'exponential', delay: 1000 }),
  removeOnComplete: 1000,
})

let connection = null
const queues = new Map()

function getConnection() {
  if (!connection) {
    connection = createRedisClient()
  }
  return connection
}

export function getQueue(name) {
  if (!Object.values(QUEUE_NAMES).includes(name)) {
    throw new Error(`Unknown queue: ${name}`)
  }
  if (!queues.has(name)) {
    queues.set(name, new Queue(name, { connection: getConnection(), defaultJobOptions: queueDefaults }))
  }
  return queues.get(name)
}

// After-commit-only: enqueue a validated job event (minimal IDs + request ID).
export async function enqueueJobEvent(payload, options = {}) {
  const data = schemas.jobEventPayloadSchema.parse(payload)
  const queue = getQueue(QUEUE_NAMES.jobEvents)
  const job = await queue.add(data.type, data, options)
  logger.info(
    { queue: QUEUE_NAMES.jobEvents, jobId: job.id, requestId: data.requestId },
    'Enqueued job event',
  )
  return job
}

// After-commit-only: schedule a delayed SLA evaluation (delay via options).
export async function scheduleSlaCheck(payload, options = {}) {
  const data = schemas.slaCheckPayloadSchema.parse(payload)
  const queue = getQueue(QUEUE_NAMES.sla)
  const job = await queue.add(data.type, data, options)
  logger.info(
    { queue: QUEUE_NAMES.sla, jobId: job.id, requestId: data.requestId },
    'Scheduled SLA check',
  )
  return job
}

// Test/worker-shutdown helper: closes queues, then the shared connection.
export async function closeQueues() {
  for (const queue of queues.values()) {
    await queue.close()
  }
  queues.clear()
  if (connection) {
    await connection.quit()
    connection = null
  }
}
