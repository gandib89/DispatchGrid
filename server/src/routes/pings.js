import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db/client.js'
import { authenticate } from '../middleware/authenticate.js'
import { actorFrom, authorize } from '../middleware/authorize.js'
import { resolveTenant } from '../middleware/resolve-tenant.js'
import { notFound } from '../errors/http-errors.js'
import { pingLimiter } from '../lib/rate-limit.js'
import { logger } from '../lib/logger.js'
import { writePosition } from '../lib/tracking/position-cache.js'
import { pingSchemas } from '../../../shared/ping-schema.js'
import { serializePing } from '../serializers/ping-serializer.js'

// B14-T3 (#40): agent ping ingestion. Same pipeline as jobs
// (authenticate -> resolveTenant -> pingLimiter -> authorize -> strict parse ->
// actorFrom -> durable insert -> serialize -> respond), plus a post-commit
// hot-cache write that never fails the request. No auditLog: this is a
// high-frequency path and every ping is already a durable history row.
// The agent identity is the actor's membership (per-org agent identity, the
// same key the limiter and the cache use) — never a body field.

const router = Router()
const schemas = pingSchemas(z)

router.post(
  '/',
  authenticate,
  resolveTenant(),
  pingLimiter,
  authorize('job.respond'),
  async (req, res, next) => {
    try {
      schemas.pingParamsSchema.parse(req.params)
      schemas.pingQuerySchema.parse(req.query)
      const input = schemas.createPingSchema.parse(req.body)
      const actor = actorFrom(req)

      // A-8: optional nullable job linkage, validated same-org. A cross-org
      // id reads as missing (404), never forbidden — the 404-not-403 rule.
      let jobId = null
      if (input.jobId) {
        const job = await prisma.job.findFirst({
          where: { id: input.jobId, organizationId: actor.organizationId },
        })
        if (!job) {
          throw notFound('Job not found')
        }
        jobId = job.id
      }

      const ping = await prisma.locationPing.create({
        data: {
          organizationId: actor.organizationId,
          agentId: actor.membershipId,
          jobId,
          latitude: input.latitude,
          longitude: input.longitude,
          accuracy: input.accuracy,
          recordedAt: new Date(input.recordedAt),
        },
      })

      // Post-commit hot-cache write: writePosition applies the no-backwards
      // rule (stale arrivals keep the newer dot) and degrades to a no-op on
      // Redis loss. A throwing hook must never fail the committed request.
      try {
        await writePosition({
          organizationId: actor.organizationId,
          agentId: actor.membershipId,
          latitude: input.latitude,
          longitude: input.longitude,
          accuracy: input.accuracy,
          recordedAt: input.recordedAt,
        })
      } catch (error) {
        logger.warn({ error }, 'Position cache write failed after ping insert')
      }

      res.status(201).json({ ping: serializePing(ping) })
    } catch (error) {
      next(error)
    }
  },
)

export default router
