import pino from 'pino'
import { env } from '../env.js'
import { config } from '../config.js'

export const logger = pino({
  name: config.serviceName,
  level: env.NODE_ENV === 'test' ? 'silent' : 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.token',
      '*.secret',
    ],
    censor: '[REDACTED]',
  },
})
