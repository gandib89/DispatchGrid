import { createRedisClient } from './lib/redis.js'
import { logger } from './lib/logger.js'

const redis = createRedisClient()
let shuttingDown = false

await redis.connect()
logger.info('DispatchGrid worker foundation connected to Redis')

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true

  logger.info({ signal }, 'Worker shutdown started')
  await redis.quit()
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
