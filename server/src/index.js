import http from 'node:http'
import { app } from './app.js'
import { env } from './env.js'
import { prisma } from './db/client.js'
import { logger } from './lib/logger.js'
import { attachSocketServer, closeSocketServer } from './lib/realtime/socket-server.js'

const server = http.createServer(app)
await attachSocketServer(server)
let shuttingDown = false

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'DispatchGrid API listening')
})

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true

  logger.info({ signal }, 'Graceful shutdown started')

  try {
    await closeSocketServer()
  } catch (error) {
    logger.error({ error }, 'Socket server failed to close cleanly')
  }

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
