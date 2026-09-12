import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db/client.js'
import { authenticate } from '../middleware/authenticate.js'
import { actorFrom, authorize } from '../middleware/authorize.js'
import { resolveTenant } from '../middleware/resolve-tenant.js'
import { auditLog } from '../middleware/audit-log.js'
import { conflict, notFound } from '../errors/http-errors.js'
import { slaSchemas } from '../../../shared/sla-schema.js'
import { serializeSlaPolicy } from '../serializers/sla-policy-serializer.js'

// B12-T2 (#32): SLA policy admin JSON. Same pipeline as jobs
// (authenticate -> resolveTenant -> authorize -> strict parse -> actorFrom ->
// serialize -> respond). Reads are visible to job viewers; writes require the
// SLA management capability. Every lookup is tenant-scoped, so a
// cross-organization id reads as missing (404), never forbidden.

const router = Router()
const schemas = slaSchemas(z)

function isUniqueViolation(error) {
  return error?.code === 'P2002'
}

async function scopedPolicy(actor, id) {
  const policy = await prisma.slaPolicy.findFirst({
    where: { id, organizationId: actor.organizationId },
  })
  if (!policy) {
    throw notFound('SLA policy not found')
  }
  return policy
}

router.get(
  '/',
  authenticate,
  resolveTenant(),
  authorize('job.view'),
  async (req, res, next) => {
    try {
      const actor = actorFrom(req)
      const policies = await prisma.slaPolicy.findMany({
        where: { organizationId: actor.organizationId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      res.json({ policies: policies.map(serializeSlaPolicy) })
    } catch (error) {
      next(error)
    }
  },
)

router.post(
  '/',
  authenticate,
  resolveTenant(),
  authorize('sla.manage'),
  auditLog,
  async (req, res, next) => {
    try {
      const input = schemas.createSlaPolicySchema.parse(req.body)
      const actor = actorFrom(req)
      let policy
      try {
        policy = await prisma.slaPolicy.create({
          data: {
            organizationId: actor.organizationId,
            name: input.name,
            warningMinutesBefore: input.warningMinutesBefore,
            breachMinutesAfter: input.breachMinutesAfter,
          },
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          next(conflict('An SLA policy with this name already exists'))
          return
        }
        throw error
      }
      req.auditEntry = {
        action: 'POST /sla-policies',
        resourceType: 'sla_policy',
        resourceId: policy.id,
      }
      res.status(201).json({ policy: serializeSlaPolicy(policy) })
    } catch (error) {
      next(error)
    }
  },
)

router.get(
  '/:id',
  authenticate,
  resolveTenant(),
  authorize('job.view'),
  async (req, res, next) => {
    try {
      const params = schemas.slaPolicyIdParamsSchema.parse(req.params)
      const policy = await scopedPolicy(actorFrom(req), params.id)
      res.json({ policy: serializeSlaPolicy(policy) })
    } catch (error) {
      next(error)
    }
  },
)

router.patch(
  '/:id',
  authenticate,
  resolveTenant(),
  authorize('sla.manage'),
  auditLog,
  async (req, res, next) => {
    try {
      const params = schemas.slaPolicyIdParamsSchema.parse(req.params)
      const input = schemas.updateSlaPolicySchema.parse(req.body)
      const actor = actorFrom(req)
      await scopedPolicy(actor, params.id)
      let policy
      try {
        policy = await prisma.slaPolicy.update({
          where: { id: params.id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.warningMinutesBefore !== undefined
              ? { warningMinutesBefore: input.warningMinutesBefore }
              : {}),
            ...(input.breachMinutesAfter !== undefined
              ? { breachMinutesAfter: input.breachMinutesAfter }
              : {}),
          },
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          next(conflict('An SLA policy with this name already exists'))
          return
        }
        throw error
      }
      req.auditEntry = {
        action: 'PATCH /sla-policies/:id',
        resourceType: 'sla_policy',
        resourceId: policy.id,
      }
      res.json({ policy: serializeSlaPolicy(policy) })
    } catch (error) {
      next(error)
    }
  },
)

export default router
