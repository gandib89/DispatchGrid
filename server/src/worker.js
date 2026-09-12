import { pathToFileURL } from 'node:url'
import { Worker, createNodeRedisClient } from 'bullmq'
import { prisma } from './db/client.js'
import { logger } from './lib/logger.js'
import { integrationAdapters } from './lib/integration-adapters.js'
import { QUEUE_NAMES, closeQueues, deadLetterIfExhausted } from './lib/queue/index.js'
import { createRedisClient } from './lib/redis.js'
import { routeQueueJob } from './worker/handlers/index.js'

// Second entrypoint (B11-T2): consumes the T1 queues through a validating
// handler router. Logging, database, Redis, handler registration — no HTTP
// listener. Importing this module boots nothing; run it (`node src/worker.js`)
// or call startWorker (tests) to register consumers.
//
// Raw node-redis clients are wrapped with createNodeRedisClient: BullMQ builds
// the worker's blocking connection by duplicating the passed connection, and a
// raw duplicate never connects, so an unwrapped client hangs waitUntilReady.
let runtime = null

// Production handler deps: breach side effects resolve through the named
// integration seam (late-bound so tests can stub the adapters). The default
// processor below uses these — never a bare { prisma, log }.
export function productionDeps(database = prisma) {
  return {
    prisma: database,
    log: logger,
    publishEscalationEvent: (...args) => integrationAdapters.publishEscalationEvent(...args),
    enqueueEscalationNotification: (...args) => integrationAdapters.enqueueEscalationNotification(...args),
  }
}

export async function startWorker(options = {}) {
  if (runtime) {
    throw new Error('Worker already started')
  }

  const {
    prisma: database = prisma,
    processor = (job) => routeQueueJob(job, productionDeps(database)),
  } = options

  const rawClients = []
  const workers = []

  for (const name of [QUEUE_NAMES.jobEvents, QUEUE_NAMES.sla]) {
    const raw = createRedisClient()
    rawClients.push(raw)
    const worker = new Worker(name, processor, { connection: createNodeRedisClient(raw) })
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

  runtime = { workers, rawClients, database }
  return runtime
}

export async function stopWorker(signal = 'SIGTERM') {
  if (!runtime) return

  const { workers, rawClients, database } = runtime
  runtime = null

  logger.info({ signal }, 'Worker shutdown started')

  // Drain, not abandon: stop fetching, finish the current job, then close.
  for (const worker of workers) {
    await worker.close()
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
