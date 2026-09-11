import crypto from 'node:crypto'
import { prisma } from '../db/client.js'
import { hashPassword } from './password.js'
import { issueRefreshToken } from './refresh-tokens.js'
import { signAccessToken } from './tokens.js'
import { HttpError } from '../errors/http-errors.js'

const ROLE_PERMISSION_CODES = {
  ADMIN: null,
  DISPATCHER: ['job.view', 'job.create', 'job.update', 'job.assign', 'job.cancel', 'report.view'],
  AGENT: ['job.view', 'job.respond'],
}

function slugify(value, fallback) {
  const base = (value || fallback || 'organization')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return base || 'organization'
}

export async function registerUser(email, password, options = {}, tx = prisma) {
  const existing = await tx.user.findUnique({ where: { email } })
  if (existing) {
    throw new HttpError(409, 'email_taken', 'Email already registered')
  }

  const normalizedEmail = email.toLowerCase()
  const displayName = options.displayName || normalizedEmail.split('@')[0] || 'New User'
  const organizationName = options.organizationName || `${displayName}'s Organization`
  const passwordHash = await hashPassword(password)

  const created = await tx.$transaction(async (transaction) => {
    const user = await transaction.user.create({
      data: { email: normalizedEmail, displayName, passwordHash },
    })

    let organization = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const slug =
        attempt === 0
          ? `${slugify(organizationName, displayName)}-${crypto.randomBytes(3).toString('hex')}`
          : `${slugify(organizationName, displayName)}-${crypto.randomBytes(4).toString('hex')}`
      try {
        organization = await transaction.organization.create({
          data: { name: organizationName, slug },
        })
        break
      } catch (error) {
        if (error?.code !== 'P2002' || attempt === 2) throw error
      }
    }

    await transaction.$executeRaw`SELECT set_config('app.organization_id', ${organization.id}::text, TRUE)`

    const permissions = await transaction.permission.findMany()
    const permissionByCode = new Map(permissions.map((permission) => [permission.code, permission]))

    const roleIds = {}
    for (const [roleName, codes] of Object.entries(ROLE_PERMISSION_CODES)) {
      const role = await transaction.role.create({
        data: {
          organizationId: organization.id,
          name: roleName,
          description: `${roleName.toLowerCase()} role`,
        },
      })
      roleIds[roleName] = role.id
      const resolvedCodes = codes || permissions.map((permission) => permission.code)
      for (const code of resolvedCodes) {
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
        userId: user.id,
        roleId: roleIds.ADMIN,
        isAvailable: false,
      },
    })

    await transaction.counter.create({
      data: { organizationId: organization.id, name: 'job-reference' },
    })

    return { user, organization, membership }
  })

  const accessToken = signAccessToken(created.user.id)
  const { raw: refreshToken } = await issueRefreshToken(created.user.id)

  return { ...created, accessToken, refreshToken }
}
