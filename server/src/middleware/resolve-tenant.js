import { prisma } from '../db/client.js'
import { notFound, badRequest, unauthorized } from '../errors/http-errors.js'
import { findOrgMembership } from '../lib/membership.js'

export function resolveTenant({ allowWithoutOrg = false } = {}) {
  return async (req, _res, next) => {
    try {
      if (!req.userId) {
        throw unauthorized('Authentication is required')
      }

      const requestedOrgId =
        req.params?.orgId || req.params?.organizationId || req.headers['x-organization-id']

      const memberships = await prisma.membership.findMany({
        where: { userId: req.userId },
        include: {
          role: {
            include: {
              rolePermissions: { include: { permission: true } },
            },
          },
        },
      })

      const { membership, reason } = findOrgMembership(memberships, requestedOrgId)
      if (!membership) {
        if (reason === 'no-membership' && allowWithoutOrg) {
          next()
          return
        }
        if (reason === 'selection-required') {
          throw badRequest('Organization selection is required', {
            header: 'x-organization-id',
          })
        }
        throw notFound('Organization not found')
      }

      const permissions = membership.role.rolePermissions.map((link) => link.permission.code)

      req.actor = {
        userId: req.userId,
        organizationId: membership.organizationId,
        membershipId: membership.id,
        roleId: membership.roleId,
        roleName: membership.role.name,
        permissions,
      }
      req.organizationId = membership.organizationId
      req.membershipId = membership.id

      next()
    } catch (error) {
      next(error)
    }
  }
}
