import { Queue, UnrecoverableError, createNodeRedisClient } from 'bullmq'
import { z } from 'zod'
import { SLA_THRESHOLDS, queueSchemas } from '../../../../shared/queue-schema.js'
import { logger } from '../logger.js'
import { createRedisClient } from '../redis.js'
import { recordDeadLettered, recordEnqueueFailure } from './metrics.js'

export { SLA_THRESHOLDS }

export { queueMetrics, recordEnqueueFailure, recordDeadLettered, recordRealtimePublishFailure, resetQueueMetrics } from './metrics.js'

// Centralized queue module (B11-T1). Single owner of Redis/BullMQ connection
// creation, named queues, shared retry/backoff defaults, and producer helpers.
// Producer helpers run ONLY after commit with plain validated data: they take
// no transaction, no Prisma client, and no ORM records. Never import this from
// services or transactions — nothing may enqueue inside a transaction.
// No business logic lives here: payloads are validated at this boundary and
// consumers re-read PostgreSQL (payload = request, not truth).
//
// Redis holds no irreplaceable business fact (B11-T5): BullMQ job storage,
// fan-out, rate limits, latest positions, and narrow caches only. PostgreSQL
// is the sole source of truth — wiping Redis loses at most pending async work,
// which reconciliation (T4) repairs. Proven by dead-letter.test.js.

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

export function createWorkerConnection() {
  const raw = createRedisClient()
  return { raw, connection: createNodeRedisClient(raw) }
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

// After-commit-only: schedule a delayed threshold evaluation (DG-4).
// The BullMQ identity is deterministic per job and threshold, so re-adding
// the same threshold collapses onto the one pending evaluation instead of
// doubling it. Delay defaults to the DG-4 fire time minus now; pass an
// explicit delay only to override the formula (tests).
export async function scheduleSlaCheck(payload, options = {}) {
  const data = schemas.slaCheckPayloadSchema.parse(payload)
  const queue = getQueue(QUEUE_NAMES.sla)
  const jobId = options.jobId ?? slaCheckJobId(data.jobId, data.threshold)
  const delay = options.delay ?? slaDelayMs({ ...data, now: options.now })
  const addOptions = { ...options }
  delete addOptions.jobId
  delete addOptions.delay
  delete addOptions.now
  // Deterministic IDs collapse re-adds onto the stored evaluation — but only
  // a still-pending one. BullMQ's add never throws for a duplicate ID; it
  // hands back the stored job whatever its state, so a settled entry
  // (completed/failed) would report "armed" with nothing pending. Check first:
  // collapse onto delayed/waiting/active work, otherwise drop the settled
  // entry and arm fresh under the same identity.
  const existing = await queue.getJob(jobId).catch(() => undefined)
  if (existing) {
    const state = await existing.getState().catch(() => undefined)
    if (state === 'delayed' || state === 'waiting' || state === 'active') {
      logger.info(
        { queue: QUEUE_NAMES.sla, jobId, requestId: data.requestId, threshold: data.threshold },
        'SLA check already scheduled; collapsing onto the pending evaluation',
      )
      return existing
    }
    await existing.remove().catch(() => {})
  }
  const job = await queue.add(data.type, data, { ...addOptions, delay, jobId })
  logger.info(
    { queue: QUEUE_NAMES.sla, jobId: job.id, requestId: data.requestId, threshold: data.threshold },
    existing ? 'Re-armed SLA check over a settled evaluation' : 'Scheduled SLA check',
  )
  return job
}

// Deterministic BullMQ identity per job and threshold (B12-T3): the same
// threshold for the same job is always the same delayed job.
export function slaCheckJobId(jobId, threshold) {
  return `sla-check:${jobId}:${threshold}`
}

// DG-4 fire-time math (decisions.md): warningAt = dueAt − warningMinutesBefore,
// breachAt = dueAt + breachMinutesAfter, so offset zero fires exactly at
// dueAt. Returns the BullMQ delay in ms; an already-past fire time schedules
// immediately (delay 0) instead of a negative delay.
export function slaDelayMs({
  dueAt,
  threshold,
  warningMinutesBefore,
  breachMinutesAfter,
  now = Date.now(),
}) {
  const dueMs = new Date(dueAt).getTime()
  const fireAtMs =
    threshold === 'WARNING' ? dueMs - warningMinutesBefore * 60_000 : dueMs + breachMinutesAfter * 60_000
  return Math.max(0, fireAtMs - new Date(now).getTime())
}

// Disarm one pending delayed evaluation. Never throws: a missing job returns
// false, and any other failure only warns and meters — the handler re-reads
// PostgreSQL state before acting, so a surviving timer is harmless.
export async function removePendingSlaEvaluation(jobId, threshold) {
  try {
    const job = await getQueue(QUEUE_NAMES.sla).getJob(slaCheckJobId(jobId, threshold))
    if (!job) return false
    await job.remove()
    logger.info(
      { queue: QUEUE_NAMES.sla, jobId: job.id, threshold },
      'Removed pending SLA evaluation',
    )
    return true
  } catch (error) {
    recordEnqueueFailure()
    logger.warn({ queue: QUEUE_NAMES.sla, jobId, threshold, error }, 'Removing pending SLA evaluation failed')
    return false
  }
}

// Disarm every pending delayed evaluation for a job (terminal transitions).
// Never throws; see removePendingSlaEvaluation.
export async function removePendingSlaEvaluations(jobId) {
  const removed = []
  for (const threshold of SLA_THRESHOLDS) {
    removed.push(await removePendingSlaEvaluation(jobId, threshold))
  }
  return removed
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

// ---- Dead-letter path (B11-T5) ----
// Poison exhausts retries (or fails unrecoverably at the router) and stays in
// the source queue's failed set; the worker also forwards one inspectable copy
// here. Queue-level inspection only — the HTTP admin surface is B13's scope.

function summarizeFailedJob(queueName, job) {
  return {
    queue: queueName,
    id: job.id,
    name: job.name,
    requestId: job.data?.requestId ?? 'unknown',
    data: job.data,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason,
    finishedOn: job.finishedOn ?? null,
    timestamp: job.timestamp ?? null,
  }
}

// List failed jobs on a source queue (the inspectable dead-letter path).
export async function getFailedJobs(queueName, { start = 0, end = 99 } = {}) {
  const queue = getQueue(queueName)
  const jobs = await queue.getFailed(start, end)
  return jobs.map((job) => summarizeFailedJob(queueName, job))
}

// List envelopes forwarded to the dead-letter queue after retry exhaustion.
export async function getDeadLetterJobs({ start = 0, end = 99 } = {}) {
  const queue = getQueue(QUEUE_NAMES.deadLetter)
  const jobs = await queue.getJobs(['waiting', 'failed'], start, end)
  return jobs.map((job) => ({
    deadLetterJobId: job.id,
    ...(job.data ?? {}),
  }))
}

// Copy an exhausted job into the dead-letter queue for inspection.
export async function sendToDeadLetter(sourceQueueName, job, error) {
  const queue = getQueue(QUEUE_NAMES.deadLetter)
  const envelope = {
    sourceQueue: sourceQueueName,
    jobId: job?.id ?? 'unknown',
    name: job?.name ?? 'unknown',
    data: job?.data ?? {},
    requestId: job?.data?.requestId ?? 'unknown',
    attemptsMade: job?.attemptsMade ?? 0,
    failedReason: error?.message ?? job?.failedReason ?? 'unknown',
    failedAt: new Date().toISOString(),
  }
  const stored = await queue.add(`${sourceQueueName}:${envelope.jobId}`, envelope)
  recordDeadLettered()
  logger.info(
    {
      queue: QUEUE_NAMES.deadLetter,
      deadLetterJobId: stored.id,
      sourceQueue: sourceQueueName,
      jobId: envelope.jobId,
      requestId: envelope.requestId,
    },
    'Moved exhausted job to dead-letter path',
  )
  return stored
}

// Called from the worker's failed listener: forward only when the job will
// never be retried again (attempts exhausted or unrecoverable poison).
// Returns the stored dead-letter job, or null when retries remain.
export async function deadLetterIfExhausted(sourceQueueName, job, error) {
  if (!job) return null
  const maxAttempts = job?.opts?.attempts ?? queueDefaults.attempts
  const exhausted =
    (job?.attemptsMade ?? 0) >= maxAttempts ||
    error instanceof UnrecoverableError ||
    error?.name === 'UnrecoverableError'
  if (!exhausted) return null
  return sendToDeadLetter(sourceQueueName, job, error)
}
