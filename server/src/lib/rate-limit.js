import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { config } from '../config.js'

function rateLimitHandler(_req, res) {
  res.status(429).json({
    error: { code: 'rate_limited', message: 'Too many requests' },
  })
}

export const apiLimiter = rateLimit({
  windowMs: config.apiRateLimit.windowMs,
  limit: config.apiRateLimit.limit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: rateLimitHandler,
})

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: rateLimitHandler,
})

export const pingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => req.actor?.membershipId || req.userId || ipKeyGenerator(req),
  handler: rateLimitHandler,
})
