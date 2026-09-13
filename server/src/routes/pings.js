import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db/client.js'
import { authenticate } from '../middleware/authenticate.js'
import { actorFrom, authorize } from '../middleware/authorize.js'
import { resolveTenant } from '../middleware/resolve-tenant.js'
import { notFound } from '../errors/http-errors.js'
import { pingLimiter } from '../lib/rate-limit.js'
import { logger } from '../lib/logger.js'
import { readPosition, writePosition } from '../lib/tracking/position-cache.js'
import { pingSchemas } from '../../../shared/ping-schema.js'
import { serializePing, serializePosition } from '../serializers/ping-serializer.js'

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
          jobId,
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

// B14-T4 (#41): dispatcher latest-positions read. Both shapes share one
// resolver: Redis-first via readPosition, forced miss degrades to the newest
// durable LocationPing row in the same envelope (only `source` differs).
// Reads are gated to dispatcher-visible roles via `report.view` — agents
// hold `job.view`/`job.respond` only, so peer positions never enumerate to
// them (not even their own dot; the POST 201 ack already confirms a write).
// Every lookup is org-scoped; unknown or cross-org agents read as 404.
async function resolveLatestPosition(organizationId, agentId) {
  const cached = await readPosition({ organizationId, agentId })
  if (cached.hit) {
    return serializePosition(cached.position, 'cache')
  }
  const row = await prisma.locationPing.findFirst({
    where: { organizationId, agentId },
    orderBy: [{ recordedAt: 'desc' }, { createdAt: 'desc' }],
  })
  if (!row) {
    return null
  }
  return serializePosition(row, 'database')
}

router.get(
  '/latest',
  authenticate,
  resolveTenant(),
  authorize('report.view'),
  async (req, res, next) => {
    try {
      schemas.pingQuerySchema.parse(req.query)
      const actor = actorFrom(req)
      // Durable agent ids cover every hot key: the cache is only written
      // after the durable insert, and prune (T5) only removes rows far older
      // than the 5-minute TTL — so a hot dot always has a durable sibling.
      const groups = await prisma.locationPing.groupBy({
        by: ['agentId'],
        where: { organizationId: actor.organizationId },
      })
      const positions = []
      for (const group of groups) {
        const position = await resolveLatestPosition(actor.organizationId, group.agentId)
        if (position) {
          positions.push(position)
        }
      }
      res.status(200).json({ positions })
    } catch (error) {
      next(error)
    }
  },
)

router.get(
  '/latest/:agentId',
  authenticate,
  resolveTenant(),
  authorize('report.view'),
  async (req, res, next) => {
    try {
      const params = schemas.agentPositionParamsSchema.parse(req.params)
      schemas.pingQuerySchema.parse(req.query)
      const actor = actorFrom(req)
      const membership = await prisma.membership.findFirst({
        where: { id: params.agentId, organizationId: actor.organizationId },
      })
      if (!membership) {
        throw notFound('Position not found')
      }
      const position = await resolveLatestPosition(actor.organizationId, params.agentId)
      if (!position) {
        throw notFound('Position not found')
      }
      res.status(200).json({ position })
    } catch (error) {
      next(error)
    }
  },
)

export default router
