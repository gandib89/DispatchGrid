import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../middleware/authenticate.js'
import { actorFrom, authorize } from '../middleware/authorize.js'
import { resolveTenant } from '../middleware/resolve-tenant.js'
import { auditLog } from '../middleware/audit-log.js'
import { notFound } from '../errors/http-errors.js'
import {
  getDeadLetterJobs,
  replayDeadLetter,
} from '../lib/queue/index.js'

// B13 dead-letter inspection (read-only list + manual replay). Same pipeline
// as other routers (authenticate -> resolveTenant -> authorize -> strict
// parse -> actorFrom -> respond). Reads require the organization management
// capability; envelopes are tenant-filtered at the edge so one organization
// never inspects another's failures. The payload `data` carries only queue
// IDs plus the originating requestId — the correlation a support engineer
// needs, never message bodies.

const router = Router()

const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()

const replayParamsSchema = z
  .object({
    id: z.string().min(1).max(128),
  })
  .strict()

function serializeDeadLetter(entry, organizationId) {
  return {
    deadLetterJobId: entry.deadLetterJobId,
    sourceQueue: entry.sourceQueue,
    jobId: entry.jobId,
    name: entry.name,
    requestId: entry.requestId,
    organizationId,
    attemptsMade: entry.attemptsMade,
    failedReason: entry.failedReason,
    failedAt: entry.failedAt,
    data: entry.data,
  }
}

router.get(
  '/',
  authenticate,
  resolveTenant(),
  authorize('org.manage'),
  async (req, res, next) => {
    try {
      const query = listQuerySchema.parse(req.query)
      const actor = actorFrom(req)
      const entries = await getDeadLetterJobs({ start: 0, end: query.limit - 1 })
      const visible = entries.filter(
        (entry) => entry?.data?.organizationId === actor.organizationId,
      )
      res.json({
        deadLetters: visible.map((entry) =>
          serializeDeadLetter(entry, actor.organizationId),
        ),
      })
    } catch (error) {
      next(error)
    }
  },
)

router.post(
  '/:id/replay',
  authenticate,
  resolveTenant(),
  authorize('org.manage'),
  auditLog,
  async (req, res, next) => {
    try {
      const params = replayParamsSchema.parse(req.params)
      const actor = actorFrom(req)
      const entries = await getDeadLetterJobs({ start: 0, end: 99 })
      const visible = entries.find(
        (entry) =>
          entry.deadLetterJobId === params.id &&
          entry?.data?.organizationId === actor.organizationId,
      )
      if (!visible) {
        throw notFound('Dead-letter entry not found')
      }
      const replayed = await replayDeadLetter(params.id)
      if (!replayed) {
        throw notFound('Dead-letter entry cannot be replayed')
      }
      req.auditEntry = {
        action: 'POST /admin/dead-letter/:id/replay',
        resourceType: 'dead_letter',
        resourceId: params.id,
      }
      res.status(202).json({ jobId: replayed.id, sourceQueue: visible.sourceQueue })
    } catch (error) {
      next(error)
    }
  },
)

export default router
