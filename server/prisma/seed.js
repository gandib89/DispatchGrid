import path from 'node:path'
import { fileURLToPath } from 'node:url'
import argon2 from 'argon2'
import { createDatabaseClient } from '../src/db/client.js'
import { env } from '../src/env.js'

export const PERMISSIONS = Object.freeze([
  ['job.view', 'View organization jobs and job history'],
  ['job.create', 'Create jobs'],
  ['job.update', 'Update mutable job fields'],
  ['job.assign', 'Assign and reassign eligible agents'],
  ['job.respond', 'Accept, decline, start, complete, or fail owned work'],
  ['job.cancel', 'Cancel jobs'],
  ['org.invite', 'Invite organization members'],
  ['org.manage', 'Manage organization members and settings'],
  ['sla.manage', 'Manage SLA policies'],
  ['report.view', 'View organization reports'],
])

export const ROLE_PERMISSIONS = Object.freeze({
  ADMIN: PERMISSIONS.map(([code]) => code),
  DISPATCHER: [
    'job.view',
    'job.create',
    'job.update',
    'job.assign',
    'job.cancel',
    'report.view',
  ],
  AGENT: ['job.view', 'job.respond'],
})

export const SEEDED_ORGANIZATIONS = Object.freeze([
  {
    slug: 'dispatchgrid-demo',
    name: 'DispatchGrid Demo Operations',
    defaultConcurrentJobCap: 3,
  },
  {
    slug: 'dispatchgrid-shadow',
    name: 'DispatchGrid Shadow Organization',
    defaultConcurrentJobCap: 2,
  },
])

const SEEDED_USERS = Object.freeze([
  {
    email: 'admin@dispatchgrid.local',
    displayName: 'Demo Admin',
    organizationSlug: 'dispatchgrid-demo',
    roleName: 'ADMIN',
    isAvailable: false,
  },
  {
    email: 'dispatcher@dispatchgrid.local',
    displayName: 'Demo Dispatcher',
    organizationSlug: 'dispatchgrid-demo',
    roleName: 'DISPATCHER',
    isAvailable: false,
  },
  {
    email: 'agent@dispatchgrid.local',
    displayName: 'Demo Field Agent',
    organizationSlug: 'dispatchgrid-demo',
    roleName: 'AGENT',
    isAvailable: true,
  },
  {
    email: 'agent@shadow.dispatchgrid.local',
    displayName: 'Shadow Field Agent',
    organizationSlug: 'dispatchgrid-shadow',
    roleName: 'AGENT',
    isAvailable: true,
  },
])

export async function seedDatabase(database) {
  const passwordHash = await argon2.hash('ChangeMe123!')
  const permissionsByCode = new Map()
  const organizationsBySlug = new Map()
  const rolesByOrganizationAndName = new Map()

  for (const [code, description] of PERMISSIONS) {
    const permission = await database.permission.upsert({
      where: { code },
      update: { description },
      create: { code, description },
    })
    permissionsByCode.set(code, permission)
  }

  for (const organizationData of SEEDED_ORGANIZATIONS) {
    const organization = await database.organization.upsert({
      where: { slug: organizationData.slug },
      update: {
        name: organizationData.name,
        defaultConcurrentJobCap: organizationData.defaultConcurrentJobCap,
      },
      create: organizationData,
    })
    organizationsBySlug.set(organization.slug, organization)

    for (const [name, permissionCodes] of Object.entries(ROLE_PERMISSIONS)) {
      const role = await database.role.upsert({
        where: {
          organizationId_name: {
            organizationId: organization.id,
            name,
          },
        },
        update: { description: `${name.toLowerCase()} role` },
        create: {
          organizationId: organization.id,
          name,
          description: `${name.toLowerCase()} role`,
        },
      })

      rolesByOrganizationAndName.set(`${organization.slug}:${name}`, role)

      for (const permissionCode of permissionCodes) {
        const permission = permissionsByCode.get(permissionCode)
        await database.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: role.id,
              permissionId: permission.id,
            },
          },
          update: { organizationId: organization.id },
          create: {
            organizationId: organization.id,
            roleId: role.id,
            permissionId: permission.id,
          },
        })
      }
    }

    await database.counter.upsert({
      where: {
        organizationId_name: {
          organizationId: organization.id,
          name: 'job-reference',
        },
      },
      update: {},
      create: {
        organizationId: organization.id,
        name: 'job-reference',
      },
    })
  }

  for (const userData of SEEDED_USERS) {
    const user = await database.user.upsert({
      where: { email: userData.email },
      update: { displayName: userData.displayName },
      create: {
        email: userData.email,
        displayName: userData.displayName,
        passwordHash,
      },
    })

    const organization = organizationsBySlug.get(userData.organizationSlug)
    const role = rolesByOrganizationAndName.get(
      `${userData.organizationSlug}:${userData.roleName}`,
    )

    await database.membership.upsert({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: user.id,
        },
      },
      update: {
        roleId: role.id,
        isAvailable: userData.isAvailable,
      },
      create: {
        organizationId: organization.id,
        userId: user.id,
        roleId: role.id,
        isAvailable: userData.isAvailable,
      },
    })
  }

  return {
    organizations: await database.organization.count(),
    users: await database.user.count(),
    memberships: await database.membership.count(),
    roles: await database.role.count(),
    permissions: await database.permission.count(),
    rolePermissions: await database.rolePermission.count(),
    counters: await database.counter.count(),
  }
}

async function main() {
  const database = createDatabaseClient(env.DATABASE_URL)

  try {
    const summary = await seedDatabase(database)
    console.info('DispatchGrid seed complete', summary)
  } finally {
    await database.$disconnect()
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
