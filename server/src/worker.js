import { pathToFileURL } from 'node:url'
import { Worker } from 'bullmq'
import { prisma } from './db/client.js'
import { logger } from './lib/logger.js'
import {
  QUEUE_NAMES,
  closeQueues,
  createWorkerConnection,
  deadLetterIfExhausted,
} from './lib/queue/index.js'
import { routeQueueJob } from './worker/handlers/index.js'
import { reconcileJobEvents } from './worker/reconcile.js'

// Second entrypoint (B11-T2): consumes the T1 queues through a validating
// handler router. Logging, database, Redis, handler registration — no HTTP
// listener. Importing this module boots nothing; run it (`node src/worker.js`)
// or call startWorker (tests) to register consumers.
//
// Raw node-redis clients are wrapped with createNodeRedisClient: BullMQ builds
// the worker's blocking connection by duplicating the passed connection, and a
// raw duplicate never connects, so an unwrapped client hangs waitUntilReady.
let runtime = null

export async function startWorker(options = {}) {
  if (runtime) {
    throw new Error('Worker already started')
  }

  const {
    prisma: database = prisma,
    processor = (job) => routeQueueJob(job, { prisma: database, log: logger }),
    workerOptions = {},
    reconciliation = true,
    reconciliationIntervalMs = 60_000,
  } = options

  const rawClients = []
  const workers = []

  for (const name of [QUEUE_NAMES.jobEvents, QUEUE_NAMES.sla]) {
    const { raw, connection } = createWorkerConnection()
    rawClients.push(raw)
    const worker = new Worker(name, processor, { ...workerOptions, connection })
    worker.on('failed', (job, error) => {
      logger.error(
        { queue: name, jobId: job?.id, requestId: job?.data?.requestId, error },
        'Worker job failed',
      )
      // Exhausted poison lands on the inspectable dead-letter path (B11-T5);
      // forwarding must never break the worker, so failures only log.
      deadLetterIfExhausted(name, job, error).catch((deadLetterError) => {
        logger.error(
          { queue: name, jobId: job?.id, error: deadLetterError },
          'Dead-letter forwarding failed',
        )
      })
    })
    worker.on('error', (error) => {
      logger.error({ queue: name, error }, 'Worker error')
    })
    workers.push(worker)
  }

  for (const worker of workers) {
    await worker.waitUntilReady()
  }

  logger.info(
    { queues: workers.map((worker) => worker.name) },
    'DispatchGrid worker started',
  )

  runtime = { workers, rawClients, database, reconciliationTimer: null }
  if (reconciliation) {
    let sweepRunning = false
    const sweep = async () => {
      if (sweepRunning) return
      sweepRunning = true
      try {
        await reconcileJobEvents({ prisma: database })
      } catch (error) {
        logger.error({ error }, 'Reconciliation sweep failed')
      } finally {
        sweepRunning = false
      }
    }
    await sweep()
    if (reconciliationIntervalMs > 0) {
      runtime.reconciliationTimer = setInterval(() => void sweep(), reconciliationIntervalMs)
      runtime.reconciliationTimer.unref()
    }
  }
  return runtime
}

export async function stopWorker(signal = 'SIGTERM', { force = false } = {}) {
  if (!runtime) return

  const { workers, rawClients, database, reconciliationTimer } = runtime
  runtime = null

  logger.info({ signal }, 'Worker shutdown started')

  if (reconciliationTimer) clearInterval(reconciliationTimer)

  // Drain, not abandon: stop fetching, finish the current job, then close.
  for (const worker of workers) {
    await worker.close(force)
  }
  await closeQueues()
  for (const raw of rawClients) {
    if (raw.isOpen) {
      await raw.quit().catch(() => {})
    }
  }
  await database.$disconnect()

  logger.info({ signal }, 'Worker shutdown complete')
}

process.once('SIGINT', () => void stopWorker('SIGINT'))
process.once('SIGTERM', () => void stopWorker('SIGTERM'))

const invokedAsMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedAsMain) {
  startWorker().catch((error) => {
    logger.error({ error }, 'Worker failed to start')
    process.exitCode = 1
  })
}
