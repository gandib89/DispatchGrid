import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { seedDatabase } from '../../prisma/seed.js'
import { prisma } from './client.js'
import { forOrganization, OrganizationScopeError } from './tenant-extension.js'
import { withOrganization } from './with-tenant.js'
import {
  createIdentityFixture,
  createOrganizationFixture,
  createOwnerTestClient,
  createRoleFixture,
  createUserFixture,
  discoverApplicationTables,
  resetDatabase,
} from '../test/helpers.js'

const ownerDatabase = createOwnerTestClient()

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
})

afterAll(async () => {
  await Promise.all([ownerDatabase.$disconnect(), prisma.$disconnect()])
})

describe('seed backbone', () => {
  it('is logically identical when run twice and includes the isolation organization', async () => {
    const first = await seedDatabase(ownerDatabase)
    const second = await seedDatabase(ownerDatabase)

    expect(second).toEqual(first)
    expect(second).toMatchObject({
      organizations: 2,
      users: 4,
      memberships: 4,
      roles: 6,
      permissions: 10,
      rolePermissions: 36,
      counters: 2,
    })

    await expect(
      ownerDatabase.organization.findUniqueOrThrow({
        where: { slug: 'dispatchgrid-shadow' },
      }),
    ).resolves.toBeDefined()
  })

  it('enforces case-insensitive global email uniqueness', async () => {
    await seedDatabase(ownerDatabase)

    const user = await ownerDatabase.user.findUnique({
      where: { email: 'ADMIN@DISPATCHGRID.LOCAL' },
    })

    expect(user?.email).toBe('admin@dispatchgrid.local')
  })
})

describe('organization database wall', () => {
  it('uses a non-superuser runtime role that cannot bypass RLS or create schema objects', async () => {
    const [role] = await prisma.$queryRaw`
      SELECT current_user AS "currentUser", rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname = current_user
    `

    expect(role).toEqual({
      currentUser: 'dispatchgrid_app',
      rolsuper: false,
      rolbypassrls: false,
    })

    await expect(
      prisma.$executeRawUnsafe('CREATE TABLE "RuntimeRoleMustNotCreate" ("id" integer)'),
    ).rejects.toThrow()
  })

  it('lets the migration owner perform DDL', async () => {
    await ownerDatabase.$executeRawUnsafe(
      'CREATE TABLE "MigrationOwnerProbe" ("id" integer PRIMARY KEY)',
    )

    try {
      const tables = await discoverApplicationTables(ownerDatabase)
      expect(tables).toContain('MigrationOwnerProbe')
    } finally {
      await ownerDatabase.$executeRawUnsafe('DROP TABLE IF EXISTS "MigrationOwnerProbe"')
    }
  })

  it('prevents Organization A from reading or writing Organization B counters', async () => {
    await seedDatabase(ownerDatabase)
    const [organizationA, organizationB] = await ownerDatabase.organization.findMany({
      orderBy: { slug: 'asc' },
    })

    const unscopedRuntimeRows = await prisma.counter.findMany()
    expect(unscopedRuntimeRows).toEqual([])

    const organizationARows = await withOrganization(prisma, organizationA.id, (transaction) =>
      transaction.$queryRaw`
        SELECT "organizationId", name, value
        FROM "Counter"
        ORDER BY name
      `,
    )

    expect(organizationARows).toHaveLength(1)
    expect(organizationARows[0].organizationId).toBe(organizationA.id)

    await expect(
      withOrganization(prisma, organizationA.id, (transaction) =>
        transaction.$executeRaw`
          INSERT INTO "Counter" ("organizationId", name, value, "updatedAt")
          VALUES (${organizationB.id}::uuid, 'forbidden-counter', 1, NOW())
        `,
      ),
    ).rejects.toThrow()

    expect(await ownerDatabase.counter.count()).toBe(2)
  })

  it('automatically scopes normal Prisma models and the Organization root', async () => {
    await seedDatabase(ownerDatabase)
    const organizations = await ownerDatabase.organization.findMany({ orderBy: { slug: 'asc' } })
    const organizationA = organizations[0]
    const organizationB = organizations[1]
    const organizationDatabase = forOrganization(prisma, organizationA.id)

    const memberships = await organizationDatabase.membership.findMany()
    expect(memberships.length).toBeGreaterThan(0)
    expect(memberships.every((membership) => membership.organizationId === organizationA.id)).toBe(
      true,
    )

    const visibleOrganizations = await organizationDatabase.organization.findMany()
    expect(visibleOrganizations.map(({ id }) => id)).toEqual([organizationA.id])

    await expect(
      organizationDatabase.membership.findMany({
        where: { organizationId: organizationB.id },
      }),
    ).rejects.toBeInstanceOf(OrganizationScopeError)
  })

  it('enforces one membership per organization/user and same-organization roles', async () => {
    const first = await createIdentityFixture(ownerDatabase)
    const secondOrganization = await createOrganizationFixture(ownerDatabase)
    const secondRole = await createRoleFixture(ownerDatabase, secondOrganization.id)
    const secondUser = await createUserFixture(ownerDatabase)

    await expect(
      ownerDatabase.membership.create({
        data: {
          organizationId: first.organization.id,
          userId: first.user.id,
          roleId: first.role.id,
        },
      }),
    ).rejects.toThrow()

    await expect(
      ownerDatabase.membership.create({
        data: {
          organizationId: first.organization.id,
          userId: secondUser.id,
          roleId: secondRole.id,
        },
      }),
    ).rejects.toThrow()
  })
})

describe('database-derived reset', () => {
  it('discovers and truncates a temporary future table without a hand-maintained list', async () => {
    await ownerDatabase.$executeRawUnsafe(
      'CREATE TABLE "ResetDiscoveryProbe" ("id" integer PRIMARY KEY)',
    )

    try {
      await ownerDatabase.$executeRawUnsafe('INSERT INTO "ResetDiscoveryProbe" ("id") VALUES (1)')
      await resetDatabase(ownerDatabase)

      const [{ count }] = await ownerDatabase.$queryRaw`
        SELECT COUNT(*)::integer AS count FROM "ResetDiscoveryProbe"
      `
      expect(count).toBe(0)
    } finally {
      await ownerDatabase.$executeRawUnsafe('DROP TABLE IF EXISTS "ResetDiscoveryProbe"')
    }
  })
})
