import crypto from 'node:crypto'
import { createDatabaseClient } from '../db/client.js'
import { env } from '../env.js'

export function createOwnerTestClient() {
  return createDatabaseClient(env.DATABASE_URL)
}

export async function discoverApplicationTables(database) {
  const rows = await database.$queryRaw`
    SELECT tablename
    FROM pg_catalog.pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
    ORDER BY tablename
  `

  return rows.map((row) => row.tablename)
}

export async function resetDatabase(database) {
  const tableNames = await discoverApplicationTables(database)
  if (tableNames.length === 0) return

  // Table identifiers cannot be query parameters. They are read from pg_catalog, escaped as
  // identifiers, and never contain caller input.
  const quotedTableNames = tableNames
    .map((tableName) => `"${tableName.replaceAll('"', '""')}"`)
    .join(', ')

  await database.$executeRawUnsafe(`TRUNCATE TABLE ${quotedTableNames} RESTART IDENTITY CASCADE`)
}

export async function createOrganizationFixture(database, overrides = {}) {
  const suffix = crypto.randomUUID().slice(0, 8)

  return database.organization.create({
    data: {
      name: `Test Organization ${suffix}`,
      slug: `test-organization-${suffix}`,
      defaultConcurrentJobCap: 3,
      ...overrides,
    },
  })
}

export async function createUserFixture(database, overrides = {}) {
  const suffix = crypto.randomUUID()

  return database.user.create({
    data: {
      email: `user-${suffix}@example.test`,
      displayName: `Test User ${suffix.slice(0, 8)}`,
      passwordHash: 'test-only-password-hash',
      ...overrides,
    },
  })
}

export async function createRoleFixture(database, organizationId, overrides = {}) {
  const suffix = crypto.randomUUID().slice(0, 8)

  return database.role.create({
    data: {
      organizationId,
      name: `TEST_ROLE_${suffix}`,
      description: 'Integration-test role',
      ...overrides,
    },
  })
}

export async function createIdentityFixture(database, overrides = {}) {
  const organization =
    overrides.organization ||
    (await createOrganizationFixture(database, overrides.organizationData))
  const user = overrides.user || (await createUserFixture(database, overrides.userData))
  const role =
    overrides.role ||
    (await createRoleFixture(database, organization.id, overrides.roleData))

  const membership = await database.membership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      roleId: role.id,
      isAvailable: overrides.isAvailable ?? false,
      concurrentJobCap: overrides.concurrentJobCap,
    },
  })

  return { organization, user, role, membership }
}
