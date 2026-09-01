import crypto from 'node:crypto'
import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import pinoHttp from 'pino-http'
import { config } from './config.js'
import { env } from './env.js'
import { logger } from './lib/logger.js'

export const app = express()

app.disable('x-powered-by')

app.use((request, response, next) => {
  const requestId = request.get('x-request-id') || crypto.randomUUID()
  request.id = requestId
  response.set('x-request-id', requestId)
  next()
})

app.use(
  pinoHttp({
    logger,
    genReqId: (request) => request.id,
    autoLogging: env.NODE_ENV !== 'test',
  }),
)
app.use(helmet())
app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }))
app.use(express.json({ limit: config.jsonLimit }))

app.get('/healthz', (_request, response) => {
  response.status(200).json({ status: 'ok' })
})

app.use(`${config.apiPrefix}`, (_request, response) => {
  response.status(404).json({
    error: {
      code: 'not_found',
      message: 'API route not found',
    },
  })
})

app.use((error, request, response, _next) => {
  request.log.error({ error }, 'Unhandled request error')
  response.status(500).json({
    error: {
      code: 'internal_error',
      message: 'An unexpected error occurred',
    },
  })
})
