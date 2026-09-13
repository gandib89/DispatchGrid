import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { seedDatabase } from '../../../prisma/seed.js'
import { getOrganizationScopedModelNames } from '../../db/tenant-extension.js'
import {
  createIdentityFixture,
  createOwnerTestClient,
  resetDatabase,
} from '../helpers.js'

const ownerDatabase = createOwnerTestClient()

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
})

afterAll(async () => {
  await ownerDatabase.$disconnect()
})

function jobData(organizationId, createdById, overrides = {}) {
  return {
    organizationId,
    reference: 'JOB-2026-000001',
    title: 'Fix basement pump',
    latitude: 51.5,
    longitude: -0.12,
    priority: 'NORMAL',
    status: 'PENDING',
    slaState: 'OK',
    currentAssigneeId: null,
    createdById,
    version: 1,
    dueAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  }
}

function pingData(organizationId, agentId, overrides = {}) {
  return {
    organizationId,
    agentId,
    jobId: null,
    latitude: 51.5,
    longitude: -0.12,
    accuracy: 5.5,
    recordedAt: new Date(),
    ...overrides,
  }
}

describe('LocationPing coordinate checks', () => {
  it('rejects latitude outside -90..90', async () => {
    const { organization, membership } = await createIdentityFixture(ownerDatabase)

    await expect(
      ownerDatabase.locationPing.create({
        data: pingData(organization.id, membership.id, { latitude: 90.000001 }),
      }),
    ).rejects.toThrow()
    await expect(
      ownerDatabase.locationPing.create({
        data: pingData(organization.id, membership.id, { latitude: -90.000001 }),
      }),
    ).rejects.toThrow()
  })

  it('rejects longitude outside -180..180', async () => {
    const { organization, membership } = await createIdentityFixture(ownerDatabase)

    await expect(
      ownerDatabase.locationPing.create({
        data: pingData(organization.id, membership.id, { longitude: 180.000001 }),
      }),
    ).rejects.toThrow()
    await expect(
      ownerDatabase.locationPing.create({
        data: pingData(organization.id, membership.id, { longitude: -180.000001 }),
      }),
    ).rejects.toThrow()
  })

  it('accepts boundary coordinates', async () => {
    const { organization, membership } = await createIdentityFixture(ownerDatabase)

    await expect(
      ownerDatabase.locationPing.create({
        data: pingData(organization.id, membership.id, { latitude: 90, longitude: 180 }),
      }),
    ).resolves.toBeDefined()
    await expect(
      ownerDatabase.locationPing.create({
        data: pingData(organization.id, membership.id, { latitude: -90, longitude: -180 }),
      }),
    ).resolves.toBeDefined()
  })
})

describe('LocationPing accuracy check', () => {
  it('rejects negative accuracy', async () => {
    const { organization, membership } = await createIdentityFixture(ownerDatabase)

    await expect(
      ownerDatabase.locationPing.create({
        data: pingData(organization.id, membership.id, { accuracy: -0.01 }),
      }),
    ).rejects.toThrow()
  })

  it('accepts zero accuracy', async () => {
    const { organization, membership } = await createIdentityFixture(ownerDatabase)

    await expect(
      ownerDatabase.locationPing.create({
        data: pingData(organization.id, membership.id, { accuracy: 0 }),
      }),
    ).resolves.toBeDefined()
  })
})

describe('LocationPing recordedAt presence', () => {
  it('rejects a NULL recordedAt via the NOT NULL column constraint', async () => {
    const { organization, membership } = await createIdentityFixture(ownerDatabase)

    // No recordedAt CHECK exists: presence rides on the NOT NULL column.
    await expect(
      ownerDatabase.$executeRaw`
        INSERT INTO "LocationPing"
          ("id", "organizationId", "agentId", "jobId", "latitude", "longitude", "accuracy", "recordedAt", "createdAt")
        VALUES
          (gen_random_uuid(), ${organization.id}::uuid, ${membership.id}::uuid, NULL, 51.5, -0.12, 5, NULL, NOW())
      `,
    ).rejects.toThrow(/null value.*recordedAt|violates not-null constraint/i)
  })
})

describe('LocationPing job association (A-8)', () => {
  it('accepts a ping without a job', async () => {
    const { organization, membership } = await createIdentityFixture(ownerDatabase)

    await expect(
      ownerDatabase.locationPing.create({
        data: pingData(organization.id, membership.id, { jobId: null }),
      }),
    ).resolves.toBeDefined()
  })

  it('accepts a ping linked to a job in the same organization', async () => {
    const { organization, user, membership } = await createIdentityFixture(ownerDatabase)
    const job = await ownerDatabase.job.create({ data: jobData(organization.id, user.id) })

    await expect(
      ownerDatabase.locationPing.create({
        data: pingData(organization.id, membership.id, { jobId: job.id }),
      }),
    ).resolves.toBeDefined()
  })

  it('rejects a ping linked to an unknown job', async () => {
    const { organization, membership } = await createIdentityFixture(ownerDatabase)

    await expect(
      ownerDatabase.locationPing.create({
        data: pingData(organization.id, membership.id, {
          jobId: '11111111-1111-1111-8111-111111111111',
        }),
      }),
    ).rejects.toThrow()
  })

  it('rejects a ping for an unknown organization', async () => {
    const { membership } = await createIdentityFixture(ownerDatabase)

    await expect(
      ownerDatabase.locationPing.create({
        data: pingData('22222222-2222-2222-8222-222222222222', membership.id),
      }),
    ).rejects.toThrow()
  })
})

describe('LocationPing tenant scoping', () => {
  it('picks up LocationPing in the derived scoped-model list', () => {
    expect(getOrganizationScopedModelNames().has('LocationPing')).toBe(true)
  })

  it('starts every LocationPing composite tenant index with organizationId', async () => {
    const rows = await ownerDatabase.$queryRaw`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'LocationPing'
        AND indexdef ILIKE '%organizationId%'
    `

    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const columns = row.indexdef.match(/\(([^)]+)\)/)[1]
      expect(columns.split(',')[0].trim().replaceAll('"', '')).toBe('organizationId')
    }
  })

  it('serves the agent-recency query from the tenant-leading index', async () => {
    const { organization, membership } = await createIdentityFixture(ownerDatabase)

    const pings = []
    const base = Date.now()
    for (let i = 0; i < 150; i += 1) {
      pings.push({
        ...pingData(organization.id, membership.id),
        recordedAt: new Date(base - i * 1000),
      })
    }
    await ownerDatabase.locationPing.createMany({ data: pings })

    const plan = await ownerDatabase.$queryRaw`
      EXPLAIN SELECT "id" FROM "LocationPing"
      WHERE "organizationId" = ${organization.id}::uuid AND "agentId" = ${membership.id}::uuid
      ORDER BY "recordedAt" DESC LIMIT 20
    `
    const text = plan.map((row) => row['QUERY PLAN']).join('\n')
    expect(text).toMatch(/Index Scan/)
  })
})

describe('seed idempotency', () => {
  it('seeds twice with identical counts', async () => {
    const first = await seedDatabase(ownerDatabase)
    const second = await seedDatabase(ownerDatabase)

    expect(second).toEqual(first)
  })
})
