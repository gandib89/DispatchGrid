import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createOwnerTestClient,
  resetDatabase,
} from '../helpers.js'
import { getOrganizationScopedModelNames } from '../../db/tenant-extension.js'

const ownerDatabase = createOwnerTestClient()

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
})

afterAll(async () => {
  await ownerDatabase.$disconnect()
})

async function createOrg(slug) {
  return ownerDatabase.organization.create({
    data: { name: `SLA Org ${slug}`, slug, defaultConcurrentJobCap: 3 },
  })
}

async function createUser(email) {
  return ownerDatabase.user.create({
    data: { email, displayName: email, passwordHash: 'test-only-password-hash' },
  })
}

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

function policyData(organizationId, overrides = {}) {
  return {
    organizationId,
    name: 'Standard',
    warningMinutesBefore: 30,
    breachMinutesAfter: 15,
    ...overrides,
  }
}

describe('SlaPolicy name uniqueness', () => {
  it('rejects a duplicate policy name inside one organization', async () => {
    const org = await createOrg('policy-dup')

    await ownerDatabase.slaPolicy.create({ data: policyData(org.id) })
    await expect(
      ownerDatabase.slaPolicy.create({
        data: policyData(org.id, { warningMinutesBefore: 10 }),
      }),
    ).rejects.toThrow()
  })

  it('allows the same policy name in different organizations', async () => {
    const orgA = await createOrg('policy-a')
    const orgB = await createOrg('policy-b')

    await ownerDatabase.slaPolicy.create({ data: policyData(orgA.id) })
    await expect(
      ownerDatabase.slaPolicy.create({ data: policyData(orgB.id) }),
    ).resolves.toBeDefined()
  })
})

describe('SlaPolicy threshold checks', () => {
  it('rejects a negative warningMinutesBefore', async () => {
    const org = await createOrg('policy-neg-warn')

    await expect(
      ownerDatabase.slaPolicy.create({
        data: policyData(org.id, { warningMinutesBefore: -1 }),
      }),
    ).rejects.toThrow()
  })

  it('rejects a negative breachMinutesAfter', async () => {
    const org = await createOrg('policy-neg-breach')

    await expect(
      ownerDatabase.slaPolicy.create({
        data: policyData(org.id, { breachMinutesAfter: -5 }),
      }),
    ).rejects.toThrow()
  })

  it('accepts zero thresholds (breach exactly at dueAt)', async () => {
    const org = await createOrg('policy-zero')

    await expect(
      ownerDatabase.slaPolicy.create({
        data: policyData(org.id, { warningMinutesBefore: 0, breachMinutesAfter: 0 }),
      }),
    ).resolves.toBeDefined()
  })
})

describe('Escalation exactly-once uniqueness', () => {
  it('rejects a duplicate escalation for the same job and threshold', async () => {
    const org = await createOrg('esc-dup')
    const creator = await createUser('esc-creator@example.test')
    const job = await ownerDatabase.job.create({ data: jobData(org.id, creator.id) })

    await ownerDatabase.escalation.create({
      data: { organizationId: org.id, jobId: job.id, threshold: 'WARNING' },
    })
    await expect(
      ownerDatabase.escalation.create({
        data: { organizationId: org.id, jobId: job.id, threshold: 'WARNING' },
      }),
    ).rejects.toThrow()
  })

  it('allows both thresholds for one job and one threshold across jobs', async () => {
    const org = await createOrg('esc-distinct')
    const creator = await createUser('esc-distinct-creator@example.test')
    const jobA = await ownerDatabase.job.create({ data: jobData(org.id, creator.id) })
    const jobB = await ownerDatabase.job.create({
      data: jobData(org.id, creator.id, { reference: 'JOB-2026-000002' }),
    })

    await ownerDatabase.escalation.create({
      data: { organizationId: org.id, jobId: jobA.id, threshold: 'WARNING' },
    })
    await expect(
      ownerDatabase.escalation.create({
        data: { organizationId: org.id, jobId: jobA.id, threshold: 'BREACH' },
      }),
    ).resolves.toBeDefined()
    await expect(
      ownerDatabase.escalation.create({
        data: { organizationId: org.id, jobId: jobB.id, threshold: 'WARNING' },
      }),
    ).resolves.toBeDefined()
  })
})

describe('Escalation immutability', () => {
  it('rejects UPDATE of an escalation', async () => {
    const org = await createOrg('esc-update')
    const creator = await createUser('esc-update-creator@example.test')
    const job = await ownerDatabase.job.create({ data: jobData(org.id, creator.id) })
    const escalation = await ownerDatabase.escalation.create({
      data: { organizationId: org.id, jobId: job.id, threshold: 'WARNING' },
    })

    await expect(
      ownerDatabase.escalation.update({
        where: { id: escalation.id },
        data: { threshold: 'BREACH' },
      }),
    ).rejects.toThrow(/immutable/)
  })

  it('rejects DELETE of an escalation', async () => {
    const org = await createOrg('esc-delete')
    const creator = await createUser('esc-delete-creator@example.test')
    const job = await ownerDatabase.job.create({ data: jobData(org.id, creator.id) })
    const escalation = await ownerDatabase.escalation.create({
      data: { organizationId: org.id, jobId: job.id, threshold: 'BREACH' },
    })

    await expect(
      ownerDatabase.escalation.delete({ where: { id: escalation.id } }),
    ).rejects.toThrow(/immutable/)
  })
})

describe('SLA tenant scoping', () => {
  it('picks up the new models in the derived scoped-model list', () => {
    const scoped = getOrganizationScopedModelNames()
    expect(scoped.has('SlaPolicy')).toBe(true)
    expect(scoped.has('Escalation')).toBe(true)
  })

  it('starts every SLA composite tenant index with organizationId', async () => {
    const rows = await ownerDatabase.$queryRaw`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('SlaPolicy', 'Escalation')
        AND indexdef ILIKE '%organizationId%'
    `

    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const columns = row.indexdef.match(/\(([^)]+)\)/)[1]
      expect(columns.split(',')[0].trim().replaceAll('"', '')).toBe('organizationId')
    }
  })
})
