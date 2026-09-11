import { prisma } from '../db/client.js'
import { notFound, badRequest, unauthorized } from '../errors/http-errors.js'

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

      if (memberships.length === 0) {
        if (allowWithoutOrg) {
          next()
          return
        }
        throw notFound('Organization not found')
      }

      let membership = null
      if (requestedOrgId) {
        membership = memberships.find((item) => item.organizationId === requestedOrgId)
        if (!membership) {
          throw notFound('Organization not found')
        }
      } else if (memberships.length === 1) {
        membership = memberships[0]
      } else {
        throw badRequest('Organization selection is required', {
          header: 'x-organization-id',
        })
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
