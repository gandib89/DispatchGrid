import pino from 'pino'
import { env } from '../env.js'
import { config } from '../config.js'
import { logRedact } from './log-redact.js'

export const logger = pino({
  name: config.serviceName,
  level: env.NODE_ENV === 'test' ? 'silent' : 'info',
  redact: logRedact,
})
