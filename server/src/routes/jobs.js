import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db/client.js'
import { authenticate } from '../middleware/authenticate.js'
import { actorFrom, authorize } from '../middleware/authorize.js'
import { resolveTenant } from '../middleware/resolve-tenant.js'
import { auditLog } from '../middleware/audit-log.js'
import { jobSchemas } from '../../../shared/job-schema.js'
import { createJob } from '../services/job-service.js'
import { scopedJob } from '../services/transaction.js'
import { serializeEvent, serializeJob } from '../serializers/job-serializer.js'
import {
  enqueueJobWork,
  publishJobEvent,
} from '../lib/integration-adapters.js'

// Seams for T2-T3 (not built here): transitions (PATCH, assign/accept/decline/
// start/complete/cancel/fail), suggestions, timeline/events. They reuse this
// pipeline (authenticate -> resolveTenant -> authorize -> strict parse ->
// actorFrom -> service -> serialize -> respond), call invalidateBoardCache
// after every committed write, and attach post-commit queue/socket hooks after
// the service promise resolves — never inside the transaction.

const router = Router()
const schemas = jobSchemas(z)

// Board cache: list reads only, never detail. Tenant-keyed, 10s TTL, every
// job write invalidates the tenant's entries. Detail always reads PostgreSQL
// so the version token for the next write is never stale.
const BOARD_CACHE_TTL_MS = 10_000
const boardCache = new Map()

function boardCacheKey(organizationId, query) {
  const status =
    query.status === undefined
      ? undefined
      : [...(Array.isArray(query.status) ? query.status : [query.status])].sort()
  return `board:${organizationId}:${JSON.stringify({
    status,
    priority: query.priority,
    assigneeId: query.assigneeId,
    slaState: query.slaState,
    dueBefore: query.dueBefore,
    page: query.page,
    pageSize: query.pageSize,
    sort: query.sort,
  })}`
}

function readBoardCache(key) {
  const entry = boardCache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    boardCache.delete(key)
    return undefined
  }
  return entry.body
}

export function invalidateBoardCache(organizationId) {
  for (const key of boardCache.keys()) {
    if (key.startsWith(`board:${organizationId}:`)) boardCache.delete(key)
  }
}

export function clearBoardCache() {
  boardCache.clear()
}

function idempotencyKeyFrom(req) {
  const raw = req.headers['idempotency-key']
  const key = Array.isArray(raw) ? raw[0] : raw
  return typeof key === 'string' && key.length > 0 ? key : undefined
}

// Board list with status/priority/assignee/SLA filters, due-before,
// pagination capped at 100, and the allowed sort set.
router.get(
  '/',
  authenticate,
  resolveTenant(),
  authorize('job.view'),
  async (req, res, next) => {
    try {
      const query = schemas.jobQuerySchema.parse(req.query)
      const actor = actorFrom(req)
      const key = boardCacheKey(actor.organizationId, query)
      const cached = readBoardCache(key)
      if (cached) {
        res.set('X-Board-Cache', 'HIT')
        res.json(cached)
        return
      }
      const statuses =
        query.status === undefined
          ? undefined
          : Array.isArray(query.status)
            ? query.status
            : [query.status]
      const where = {
        organizationId: actor.organizationId,
        ...(statuses ? { status: { in: statuses } } : {}),
        ...(query.priority ? { priority: query.priority } : {}),
        ...(query.assigneeId ? { currentAssigneeId: query.assigneeId } : {}),
        ...(query.slaState ? { slaState: query.slaState } : {}),
        ...(query.dueBefore ? { dueAt: { lt: new Date(query.dueBefore) } } : {}),
      }
      // Priority desc surfaces URGENT first (Postgres orders the enum LOW..URGENT).
      const orderBy =
        query.sort === 'priority'
          ? [{ priority: 'desc' }, { dueAt: 'asc' }, { id: 'asc' }]
          : [{ [query.sort]: 'asc' }, { id: 'asc' }]
      const [total, rows] = await Promise.all([
        prisma.job.count({ where }),
        prisma.job.findMany({
          where,
          orderBy,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ])
      const body = {
        jobs: rows.map(serializeJob),
        page: query.page,
        pageSize: query.pageSize,
        total,
      }
      boardCache.set(key, { expiresAt: Date.now() + BOARD_CACHE_TTL_MS, body })
      res.set('X-Board-Cache', 'MISS')
      res.json(body)
    } catch (error) {
      next(error)
    }
  },
)

// Idempotent create: Idempotency-Key in, Idempotent-Replay marker out on replay.
router.post(
  '/',
  authenticate,
  resolveTenant(),
  authorize('job.create'),
  auditLog,
  async (req, res, next) => {
    try {
      const input = schemas.createJobSchema.parse(req.body)
      const actor = actorFrom(req)
      const { job, replay } = await createJob(actor, input, {
        key: idempotencyKeyFrom(req),
      })
      invalidateBoardCache(actor.organizationId)
      // Post-commit seam (T4 no-ops): commit already happened inside the
      // service; a throwing hook must never fail the request or the board.
      try {
        await publishJobEvent({
          jobId: job.id,
          organizationId: actor.organizationId,
          status: job.status,
        })
        await enqueueJobWork({
          jobId: job.id,
          organizationId: actor.organizationId,
        })
      } catch (error) {
        req.log?.warn?.({ error }, 'Post-commit integration hook failed')
      }
      if (replay) {
        req.idempotentReplay = true
        res.set('Idempotent-Replay', 'true')
      }
      req.auditEntry = {
        action: 'POST /jobs',
        resourceType: 'job',
        resourceId: job.id,
      }
      res.status(201).json({ job: serializeJob(job) })
    } catch (error) {
      next(error)
    }
  },
)

// Detail is never cached: always fresh, carrying the current version.
router.get(
  '/:id',
  authenticate,
  resolveTenant(),
  authorize('job.view'),
  async (req, res, next) => {
    try {
      const params = schemas.jobIdParamsSchema.parse(req.params)
      const job = await scopedJob(prisma, actorFrom(req), params.id)
      res.json({ job: serializeJob(job) })
    } catch (error) {
      next(error)
    }
  },
)

// Durable per-job timeline: ordered JobEvent history (actor, transition,
// reason, time). Scoped read — cross-org returns 404, never 403. Uncached.
router.get(
  '/:id/events',
  authenticate,
  resolveTenant(),
  authorize('job.view'),
  async (req, res, next) => {
    try {
      const params = schemas.jobIdParamsSchema.parse(req.params)
      const actor = actorFrom(req)
      await scopedJob(prisma, actor, params.id)
      const events = await prisma.jobEvent.findMany({
        where: { jobId: params.id, organizationId: actor.organizationId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      res.json({ events: events.map(serializeEvent) })
    } catch (error) {
      next(error)
    }
  },
)

export default router
