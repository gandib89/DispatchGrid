import http from 'node:http'
import { app } from './app.js'
import { env } from './env.js'
import { prisma } from './db/client.js'
import { logger } from './lib/logger.js'

const server = http.createServer(app)
let shuttingDown = false

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'DispatchGrid API listening')
})

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true

  logger.info({ signal }, 'Graceful shutdown started')

  server.close(async (error) => {
    await prisma.$disconnect()

    if (error) {
      logger.error({ error }, 'HTTP server failed to close cleanly')
      process.exitCode = 1
    }
  })
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
