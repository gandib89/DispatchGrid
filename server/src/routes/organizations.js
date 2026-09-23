import { Router } from 'express'
import { z } from 'zod'
import crypto from 'node:crypto'
import { prisma } from '../db/client.js'
import { authenticate } from '../middleware/authenticate.js'
import { actorFrom, authorize } from '../middleware/authorize.js'
import { resolveTenant } from '../middleware/resolve-tenant.js'
import { auditLog } from '../middleware/audit-log.js'
import { notFound, badRequest } from '../errors/http-errors.js'
import { getRequestContext } from '../lib/request-context.js'
import { organizationSchemas } from '../../../shared/organization-schema.js'
import { invitationSchemas } from '../../../shared/invitation-schema.js'
import { issueInvitation, revokeInvitation } from '../services/invitation-service.js'
import { enqueueInviteDelivery } from '../lib/queue/index.js'
import { recordEnqueueFailure } from '../lib/queue/metrics.js'
import {
  serializeOrganization,
  serializeMembership,
  serializeInvitation,
} from '../serializers/organization-serializer.js'

const router = Router()
const schemas = organizationSchemas(z)
const inviteSchemas = invitationSchemas(z)

function slugify(value) {
  const base = (value || 'organization')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return base || 'organization'
}

async function createOrganizationWithRoles(transaction, name, defaultConcurrentJobCap, userId) {
  let organization = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const slug = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`
    try {
      organization = await transaction.organization.create({
        data: {
          name,
          slug,
          defaultConcurrentJobCap: defaultConcurrentJobCap ?? 3,
        },
      })
      break
    } catch (error) {
      if (error?.code !== 'P2002' || attempt === 2) throw error
    }
  }

  await transaction.$executeRaw`SELECT set_config('app.organization_id', ${organization.id}::text, TRUE)`

  const permissions = await transaction.permission.findMany()
  const permissionByCode = new Map(permissions.map((permission) => [permission.code, permission]))
  const rolePlans = {
    ADMIN: null,
    DISPATCHER: ['job.view', 'job.create', 'job.update', 'job.assign', 'job.cancel', 'report.view'],
    AGENT: ['job.view', 'job.respond'],
  }

  const roleIds = {}
  for (const [roleName, codes] of Object.entries(rolePlans)) {
    const role = await transaction.role.create({
      data: {
        organizationId: organization.id,
        name: roleName,
        description: `${roleName.toLowerCase()} role`,
      },
    })
    roleIds[roleName] = role.id
    const resolved = codes || permissions.map((permission) => permission.code)
    for (const code of resolved) {
      const permission = permissionByCode.get(code)
      if (!permission) continue
      await transaction.rolePermission.create({
        data: {
          organizationId: organization.id,
          roleId: role.id,
          permissionId: permission.id,
        },
      })
    }
  }

  const membership = await transaction.membership.create({
    data: {
      organizationId: organization.id,
      userId,
      roleId: roleIds.ADMIN,
      isAvailable: false,
    },
  })

  await transaction.counter.create({
    data: { organizationId: organization.id, name: 'job-reference' },
  })

  return { organization, membership }
}

// List organizations the caller belongs to. Authenticated only; no tenant needed.
router.get('/', authenticate, async (req, res, next) => {
  try {
    const memberships = await prisma.membership.findMany({
      where: { userId: req.userId },
      include: { organization: true },
    })
    res.json({
      organizations: memberships.map((item) => serializeOrganization(item.organization)),
    })
  } catch (error) {
    next(error)
  }
})

// Create a new organization; caller becomes ADMIN. Authenticated only.
router.post('/', authenticate, auditLog, async (req, res, next) => {
  try {
    const input = schemas.createOrganizationSchema.parse(req.body)
    const { organization } = await prisma.$transaction((transaction) =>
      createOrganizationWithRoles(
        transaction,
        input.name,
        input.defaultConcurrentJobCap,
        req.userId,
      ),
    )
    req.auditEntry = {
      action: 'POST /organizations',
      resourceType: 'organization',
      resourceId: organization.id,
    }
    res.status(201).json({ organization: serializeOrganization(organization) })
  } catch (error) {
    next(error)
  }
})

// List members of one organization. Cross-org reads return 404, never 403.
router.get(
  '/:orgId/members',
  authenticate,
  resolveTenant(),
  async (req, res, next) => {
    try {
      const params = schemas.organizationIdParamsSchema.parse(req.params)
      if (params.orgId !== req.actor.organizationId) {
        throw notFound('Organization not found')
      }
      const members = await prisma.membership.findMany({
        where: { organizationId: req.actor.organizationId },
        include: { user: true, role: true },
        orderBy: { createdAt: 'asc' },
      })
      res.json({ members: members.map(serializeMembership) })
    } catch (error) {
      next(error)
    }
  },
)

// Update a member (role, availability, cap override). Requires org.manage.
router.patch(
  '/:orgId/members/:membershipId',
  authenticate,
  resolveTenant(),
  authorize('org.manage'),
  auditLog,
  async (req, res, next) => {
    try {
      const params = schemas.memberParamsSchema.parse(req.params)
      if (params.orgId !== req.actor.organizationId) {
        throw notFound('Organization not found')
      }
      const input = schemas.updateMemberSchema.parse(req.body)

      const target = await prisma.membership.findFirst({
        where: { id: params.membershipId, organizationId: req.actor.organizationId },
      })
      if (!target) {
        throw notFound('Member not found')
      }

      if (input.roleId) {
        const role = await prisma.role.findFirst({
          where: { id: input.roleId, organizationId: req.actor.organizationId },
        })
        if (!role) {
          throw badRequest('Role does not belong to this organization')
        }
      }

      const updated = await prisma.membership.update({
        where: { id: target.id },
        data: {
          ...(input.roleId ? { roleId: input.roleId } : {}),
          ...(input.isAvailable !== undefined ? { isAvailable: input.isAvailable } : {}),
          ...(input.concurrentJobCap !== undefined
            ? { concurrentJobCap: input.concurrentJobCap }
            : {}),
        },
        include: { user: true, role: true },
      })

      req.auditEntry = {
        action: 'PATCH /organizations/:orgId/members/:membershipId',
        resourceType: 'membership',
        resourceId: updated.id,
      }
      res.json({ member: serializeMembership(updated) })
    } catch (error) {
      next(error)
    }
  },
)

// Issue a pending invitation (B16-T3). The plaintext token never reaches the
// response — it travels only in the after-commit delivery enqueue, and a
// failed enqueue is warned and metered while the committed invitation stands.
router.post(
  '/:orgId/invitations',
  authenticate,
  resolveTenant(),
  authorize('org.invite'),
  auditLog,
  async (req, res, next) => {
    try {
      schemas.organizationIdParamsSchema.parse(req.params)
      const input = inviteSchemas.issueInvitationSchema.parse(req.body)
      const actor = actorFrom(req)

      const { invitation, token } = await issueInvitation(actor, input)

      const requestId = req.id ?? getRequestContext()?.requestId ?? crypto.randomUUID()
      try {
        await enqueueInviteDelivery({
          type: 'invite-delivery',
          invitationId: invitation.id,
          organizationId: invitation.organizationId,
          email: invitation.email,
          token,
          expiresAt: invitation.expiresAt.toISOString(),
          requestId,
        })
      } catch (error) {
        recordEnqueueFailure()
        req.log?.warn?.(
          { error, invitationId: invitation.id, requestId },
          'Invite delivery enqueue failed',
        )
      }

      req.auditEntry = {
        action: 'POST /organizations/:orgId/invitations',
        resourceType: 'invitation',
        resourceId: invitation.id,
      }
      res.status(201).json({ invitation: serializeInvitation(invitation) })
    } catch (error) {
      next(error)
    }
  },
)

// Revoke hard-deletes a pending invitation; accepted reads 409 and unknown
// or cross-organization ids read 404, never 403.
router.delete(
  '/:orgId/invitations/:invitationId',
  authenticate,
  resolveTenant(),
  authorize('org.invite'),
  auditLog,
  async (req, res, next) => {
    try {
      const params = inviteSchemas.invitationIdParamsSchema.parse(req.params)
      const actor = actorFrom(req)

      const { invitation } = await revokeInvitation(actor, {
        invitationId: params.invitationId,
      })

      req.auditEntry = {
        action: 'DELETE /organizations/:orgId/invitations/:invitationId',
        resourceType: 'invitation',
        resourceId: invitation.id,
      }
      res.json({ invitation: serializeInvitation(invitation) })
    } catch (error) {
      next(error)
    }
  },
)

export default router
