import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { config } from '../config.js'

// Redis-out policy (B11-T5): these limiters are process-local — no Redis store
// — so they enforce identically with Redis up or down (fail-open with respect
// to Redis: a Redis outage neither loosens nor tightens HTTP limits). During
// an outage REST keeps its configured budgets while async work pauses: the
// post-commit enqueue failure is warned + counted and never rolls back the
// request. Do not add a Redis-backed limiter without revisiting this policy
// and the Redis-out drill in test/queue/dead-letter.test.js.

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
