import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import pinoHttp from 'pino-http'
import { ZodError } from 'zod'
import { config } from './config.js'
import { env } from './env.js'
import { errorEnvelope, HttpError, notFound } from './errors/http-errors.js'
import { logger } from './lib/logger.js'
import { requestContextMiddleware } from './lib/request-context.js'
import { apiLimiter } from './lib/rate-limit.js'
import authRouter from './routes/auth.js'
import jobsRouter from './routes/jobs.js'
import organizationsRouter from './routes/organizations.js'
import pingsRouter from './routes/pings.js'
import slaPoliciesRouter from './routes/sla-policies.js'

export const app = express()

app.disable('x-powered-by')

app.use(requestContextMiddleware)
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

app.use(config.apiPrefix, apiLimiter)
app.use(`${config.apiPrefix}/auth`, authRouter)
app.use(`${config.apiPrefix}/jobs`, jobsRouter)
app.use(`${config.apiPrefix}/organizations`, organizationsRouter)
app.use(`${config.apiPrefix}/pings`, pingsRouter)
app.use(`${config.apiPrefix}/sla-policies`, slaPoliciesRouter)

app.use(config.apiPrefix, (_request, _response, next) => {
  next(notFound('API route not found'))
})

app.use((error, request, response, _next) => {
  if (error instanceof HttpError) {
    response.status(error.status).json(errorEnvelope(error))
    return
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      error: {
        code: 'validation_error',
        message: 'The request is invalid',
        details: error.issues,
      },
    })
    return
  }

  request.log.error({ error }, 'Unhandled request error')
  response
    .status(500)
    .json(errorEnvelope(new HttpError(500, 'internal_error', 'An unexpected error occurred')))
})
