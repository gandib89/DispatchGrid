import { createClient } from 'redis'
import { env } from '../env.js'
import { logger } from './logger.js'

export function createRedisClient() {
  const client = createClient({ url: env.REDIS_URL })

  client.on('error', (error) => {
    logger.error({ error }, 'Redis client error')
  })

  return client
}
