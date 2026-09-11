import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db/client.js'
import { authenticate } from '../middleware/authenticate.js'
import { actorFrom, authorize } from '../middleware/authorize.js'
import { resolveTenant } from '../middleware/resolve-tenant.js'
import { auditLog } from '../middleware/audit-log.js'
import { jobSchemas } from '../../../shared/job-schema.js'
import { cancelJob, completeJob, createJob, failJob, patchJob, startJob } from '../services/job-service.js'
import { acceptJob, assignJob, declineJob } from '../services/assignment-service.js'
import { suggestAgents } from '../services/suggestion-service.js'
import { scopedJob } from '../services/transaction.js'
import { serializeAssignment, serializeJob } from '../serializers/job-serializer.js'

// Seams for T3-T4 (not built here): assignment (assign/accept/decline),
// suggestions, timeline/events. They reuse this pipeline (authenticate -> resolveTenant -> authorize -> strict parse ->
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

// Contested-write transitions: parse, build actor, call service, serialize,
// respond, then invalidate the tenant board cache. Business rules live in
// job-service; handlers only translate HTTP to service calls.
router.patch(
  '/:id',
  authenticate,
  resolveTenant(),
  authorize('job.update'),
  auditLog,
  async (req, res, next) => {
    try {
      const params = schemas.jobIdParamsSchema.parse(req.params)
      const input = schemas.updateJobSchema.parse(req.body)
      const actor = actorFrom(req)
      const { job, replay } = await patchJob(actor, params.id, input, {
        key: idempotencyKeyFrom(req),
      })
      invalidateBoardCache(actor.organizationId)
      if (replay) {
        req.idempotentReplay = true
        res.set('Idempotent-Replay', 'true')
      }
      req.auditEntry = {
        action: 'PATCH /jobs/:id',
        resourceType: 'job',
        resourceId: job.id,
      }
      res.json({ job: serializeJob(job) })
    } catch (error) {
      next(error)
    }
  },
)

router.post(
  '/:id/start',
  authenticate,
  resolveTenant(),
  authorize('job.respond'),
  auditLog,
  async (req, res, next) => {
    try {
      const params = schemas.jobIdParamsSchema.parse(req.params)
      const input = schemas.versionOnlySchema.parse(req.body)
      const actor = actorFrom(req)
      const { job, replay } = await startJob(
        actor,
        params.id,
        { version: input.version, key: idempotencyKeyFrom(req) },
      )
      invalidateBoardCache(actor.organizationId)
      if (replay) {
        req.idempotentReplay = true
        res.set('Idempotent-Replay', 'true')
      }
      req.auditEntry = {
        action: 'POST /jobs/:id/start',
        resourceType: 'job',
        resourceId: job.id,
      }
      res.json({ job: serializeJob(job) })
    } catch (error) {
      next(error)
    }
  },
)

router.post(
  '/:id/complete',
  authenticate,
  resolveTenant(),
  authorize('job.respond'),
  auditLog,
  async (req, res, next) => {
    try {
      const params = schemas.jobIdParamsSchema.parse(req.params)
      const input = schemas.completeJobSchema.parse(req.body)
      const actor = actorFrom(req)
      const { job, replay } = await completeJob(
        actor,
        params.id,
        { version: input.version, key: idempotencyKeyFrom(req) },
      )
      invalidateBoardCache(actor.organizationId)
      if (replay) {
        req.idempotentReplay = true
        res.set('Idempotent-Replay', 'true')
      }
      req.auditEntry = {
        action: 'POST /jobs/:id/complete',
        resourceType: 'job',
        resourceId: job.id,
      }
      res.json({ job: serializeJob(job) })
    } catch (error) {
      next(error)
    }
  },
)

router.post(
  '/:id/cancel',
  authenticate,
  resolveTenant(),
  authorize('job.cancel'),
  auditLog,
  async (req, res, next) => {
    try {
      const params = schemas.jobIdParamsSchema.parse(req.params)
      const input = schemas.cancelJobSchema.parse(req.body)
      const actor = actorFrom(req)
      const { job, replay } = await cancelJob(
        actor,
        params.id,
        { version: input.version, reason: input.reason, key: idempotencyKeyFrom(req) },
      )
      invalidateBoardCache(actor.organizationId)
      if (replay) {
        req.idempotentReplay = true
        res.set('Idempotent-Replay', 'true')
      }
      req.auditEntry = {
        action: 'POST /jobs/:id/cancel',
        resourceType: 'job',
        resourceId: job.id,
      }
      res.json({ job: serializeJob(job) })
    } catch (error) {
      next(error)
    }
  },
)

router.post(
  '/:id/fail',
  authenticate,
  resolveTenant(),
  authorize('job.respond'),
  auditLog,
  async (req, res, next) => {
    try {
      const params = schemas.jobIdParamsSchema.parse(req.params)
      const input = schemas.failJobSchema.parse(req.body)
      const actor = actorFrom(req)
      const { job, replay } = await failJob(
        actor,
        params.id,
        { version: input.version, reason: input.reason, key: idempotencyKeyFrom(req) },
      )
      invalidateBoardCache(actor.organizationId)
      if (replay) {
        req.idempotentReplay = true
        res.set('Idempotent-Replay', 'true')
      }
      req.auditEntry = {
        action: 'POST /jobs/:id/fail',
        resourceType: 'job',
        resourceId: job.id,
      }
      res.json({ job: serializeJob(job) })
    } catch (error) {
      next(error)
    }
  },
)

// ---- B10-T3 (#22): assignment + suggestions routes (additive) ----
// Human-assignment endpoints over HTTP. Same pipeline as above
// (authenticate -> resolveTenant -> authorize -> strict parse -> actorFrom ->
// service -> serialize -> respond); every committed write invalidates the
// tenant board cache. Status contract follows the services' idempotency
// responseStatus: 200 with { job, assignment } for offer/response moves
// (POST / stays the only 201). Version is mandatory on all three writes;
// stale versions surface as 409 version_conflict carrying fresh
// { currentVersion, currentStatus }. T2 (PATCH/transitions) and T4
// (timeline/audit/adapters) seams above are untouched.

// Offer a PENDING job to an eligible agent. Idempotent via Idempotency-Key.
router.post(
  '/:id/assign',
  authenticate,
  resolveTenant(),
  authorize('job.assign'),
  auditLog,
  async (req, res, next) => {
    try {
      const params = schemas.jobIdParamsSchema.parse(req.params)
      const body = schemas.assignJobSchema.parse(req.body)
      const actor = actorFrom(req)
      const { job, assignment, replay } = await assignJob(actor, params.id, body.agentId, body.version, {
        key: idempotencyKeyFrom(req),
      })
      invalidateBoardCache(actor.organizationId)
      if (replay) {
        req.idempotentReplay = true
        res.set('Idempotent-Replay', 'true')
      }
      req.auditEntry = {
        action: 'POST /jobs/:id/assign',
        resourceType: 'assignment',
        resourceId: assignment.id,
      }
      res.status(200).json({ job: serializeJob(job), assignment: serializeAssignment(assignment) })
    } catch (error) {
      next(error)
    }
  },
)

// Accept the caller's own OFFERED assignment. Ownership + version enforced
// in the service: another agent's offer is 409 version_conflict, no offer
// at all is 422 invalid_transition.
router.post(
  '/:id/accept',
  authenticate,
  resolveTenant(),
  authorize('job.respond'),
  auditLog,
  async (req, res, next) => {
    try {
      const params = schemas.jobIdParamsSchema.parse(req.params)
      const body = schemas.versionOnlySchema.parse(req.body)
      const actor = actorFrom(req)
      const { job, assignment, replay } = await acceptJob(actor, params.id, {
        version: body.version,
        key: idempotencyKeyFrom(req),
      })
      invalidateBoardCache(actor.organizationId)
      if (replay) {
        req.idempotentReplay = true
        res.set('Idempotent-Replay', 'true')
      }
      req.auditEntry = {
        action: 'POST /jobs/:id/accept',
        resourceType: 'assignment',
        resourceId: assignment.id,
      }
      res.status(200).json({ job: serializeJob(job), assignment: serializeAssignment(assignment) })
    } catch (error) {
      next(error)
    }
  },
)

// Decline the caller's own OFFERED assignment; the job returns to PENDING.
router.post(
  '/:id/decline',
  authenticate,
  resolveTenant(),
  authorize('job.respond'),
  auditLog,
  async (req, res, next) => {
    try {
      const params = schemas.jobIdParamsSchema.parse(req.params)
      const body = schemas.versionOnlySchema.parse(req.body)
      const actor = actorFrom(req)
      const { job, assignment, replay } = await declineJob(actor, params.id, {
        version: body.version,
        key: idempotencyKeyFrom(req),
      })
      invalidateBoardCache(actor.organizationId)
      if (replay) {
        req.idempotentReplay = true
        res.set('Idempotent-Replay', 'true')
      }
      req.auditEntry = {
        action: 'POST /jobs/:id/decline',
        resourceType: 'assignment',
        resourceId: assignment.id,
      }
      res.status(200).json({ job: serializeJob(job), assignment: serializeAssignment(assignment) })
    } catch (error) {
      next(error)
    }
  },
)

// Ranked eligible agents with component scores. Pure deterministic read:
// no writes, succeeds with zero candidates, never cached. Positions default
// to unknown (B14 tracking plugs live coordinates into this seam later).
router.get(
  '/:id/suggestions',
  authenticate,
  resolveTenant(),
  authorize('job.assign'),
  async (req, res, next) => {
    try {
      const params = schemas.jobIdParamsSchema.parse(req.params)
      const suggestions = await suggestAgents(actorFrom(req), params.id)
      res.json({ suggestions })
    } catch (error) {
      next(error)
    }
  },
)

export default router
