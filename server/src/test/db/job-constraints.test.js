import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
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

async function createOrg(slug) {
  return ownerDatabase.organization.create({
    data: { name: `Job Org ${slug}`, slug, defaultConcurrentJobCap: 3 },
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

describe('Job coordinate checks', () => {
  it('rejects latitude outside -90..90', async () => {
    const org = await createOrg('coords-lat')
    const creator = await createUser('lat-creator@example.test')

    await expect(
      ownerDatabase.job.create({ data: jobData(org.id, creator.id, { latitude: 90.000001 }) }),
    ).rejects.toThrow()
    await expect(
      ownerDatabase.job.create({ data: jobData(org.id, creator.id, { latitude: -90.000001 }) }),
    ).rejects.toThrow()
  })

  it('rejects longitude outside -180..180', async () => {
    const org = await createOrg('coords-lon')
    const creator = await createUser('lon-creator@example.test')

    await expect(
      ownerDatabase.job.create({ data: jobData(org.id, creator.id, { longitude: 180.000001 }) }),
    ).rejects.toThrow()
    await expect(
      ownerDatabase.job.create({ data: jobData(org.id, creator.id, { longitude: -180.000001 }) }),
    ).rejects.toThrow()
  })

  it('accepts boundary coordinates', async () => {
    const org = await createOrg('coords-edge')
    const creator = await createUser('edge-creator@example.test')

    await expect(
      ownerDatabase.job.create({
        data: jobData(org.id, creator.id, { latitude: 90, longitude: 180 }),
      }),
    ).resolves.toBeDefined()
  })
})

describe('Job reference uniqueness', () => {
  it('rejects a duplicate reference inside one organization', async () => {
    const org = await createOrg('ref-dup')
    const creator = await createUser('ref-creator@example.test')

    await ownerDatabase.job.create({ data: jobData(org.id, creator.id) })
    await expect(
      ownerDatabase.job.create({ data: jobData(org.id, creator.id, { title: 'Second job' }) }),
    ).rejects.toThrow()
  })

  it('allows the same reference in different organizations', async () => {
    const orgA = await createOrg('ref-a')
    const orgB = await createOrg('ref-b')
    const creator = await createUser('ref-creator-2@example.test')

    await ownerDatabase.job.create({ data: jobData(orgA.id, creator.id) })
    await expect(
      ownerDatabase.job.create({ data: jobData(orgB.id, creator.id) }),
    ).resolves.toBeDefined()
  })
})

describe('Job status/assignee consistency', () => {
  it('rejects PENDING or CANCELLED with an assignee', async () => {
    const org = await createOrg('assignee-idle')
    const creator = await createUser('idle-creator@example.test')
    const agent = await createUser('idle-agent@example.test')

    await expect(
      ownerDatabase.job.create({
        data: jobData(org.id, creator.id, { status: 'PENDING', currentAssigneeId: agent.id }),
      }),
    ).rejects.toThrow()
    await expect(
      ownerDatabase.job.create({
        data: jobData(org.id, creator.id, { status: 'CANCELLED', currentAssigneeId: agent.id }),
      }),
    ).rejects.toThrow()
  })

  it('rejects active statuses without an assignee', async () => {
    const org = await createOrg('assignee-active')
    const creator = await createUser('active-creator@example.test')

    for (const status of ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED']) {
      await expect(
        ownerDatabase.job.create({
          data: jobData(org.id, creator.id, {
            status,
            completedAt: status === 'COMPLETED' ? new Date() : undefined,
          }),
        }),
      ).rejects.toThrow()
    }
  })

  it('accepts ASSIGNED with an assignee', async () => {
    const org = await createOrg('assignee-ok')
    const creator = await createUser('ok-creator@example.test')
    const agent = await createUser('ok-agent@example.test')

    await expect(
      ownerDatabase.job.create({
        data: jobData(org.id, creator.id, { status: 'ASSIGNED', currentAssigneeId: agent.id }),
      }),
    ).resolves.toBeDefined()
  })
})

describe('Job completion consistency', () => {
  it('requires completedAt exactly when status is COMPLETED', async () => {
    const org = await createOrg('completed-at')
    const creator = await createUser('done-creator@example.test')
    const agent = await createUser('done-agent@example.test')

    await expect(
      ownerDatabase.job.create({
        data: jobData(org.id, creator.id, {
          status: 'COMPLETED',
          currentAssigneeId: agent.id,
          completedAt: null,
        }),
      }),
    ).rejects.toThrow()

    await expect(
      ownerDatabase.job.create({
        data: jobData(org.id, creator.id, { status: 'PENDING', completedAt: new Date() }),
      }),
    ).rejects.toThrow()

    await expect(
      ownerDatabase.job.create({
        data: jobData(org.id, creator.id, {
          status: 'COMPLETED',
          currentAssigneeId: agent.id,
          completedAt: new Date(),
        }),
      }),
    ).resolves.toBeDefined()
  })
})

describe('Assignment single-active rule', () => {
  it('rejects two active assignments for one job', async () => {
    const org = await createOrg('assign-race')
    const creator = await createUser('race-creator@example.test')
    const agentA = await createUser('race-a@example.test')
    const agentB = await createUser('race-b@example.test')

    const job = await ownerDatabase.job.create({
      data: jobData(org.id, creator.id, { status: 'ASSIGNED', currentAssigneeId: agentA.id }),
    })

    await ownerDatabase.assignment.create({
      data: { organizationId: org.id, jobId: job.id, agentId: agentA.id, state: 'OFFERED' },
    })

    await expect(
      ownerDatabase.assignment.create({
        data: { organizationId: org.id, jobId: job.id, agentId: agentB.id, state: 'OFFERED' },
      }),
    ).rejects.toThrow()

    await expect(
      ownerDatabase.assignment.create({
        data: { organizationId: org.id, jobId: job.id, agentId: agentA.id, state: 'ACCEPTED' },
      }),
    ).rejects.toThrow()
  })

  it('permits a new offer after the old assignment is revoked', async () => {
    const org = await createOrg('assign-revoke')
    const creator = await createUser('revoke-creator@example.test')
    const agentA = await createUser('revoke-a@example.test')
    const agentB = await createUser('revoke-b@example.test')

    const job = await ownerDatabase.job.create({
      data: jobData(org.id, creator.id, { status: 'ASSIGNED', currentAssigneeId: agentA.id }),
    })

    const first = await ownerDatabase.assignment.create({
      data: { organizationId: org.id, jobId: job.id, agentId: agentA.id, state: 'OFFERED' },
    })
    await ownerDatabase.assignment.update({
      where: { id: first.id },
      data: { state: 'REVOKED' },
    })

    await expect(
      ownerDatabase.assignment.create({
        data: { organizationId: org.id, jobId: job.id, agentId: agentB.id, state: 'OFFERED' },
      }),
    ).resolves.toBeDefined()
  })

  it('does not treat declined history as active', async () => {
    const org = await createOrg('assign-decline')
    const creator = await createUser('decline-creator@example.test')
    const agent = await createUser('decline-agent@example.test')

    const job = await ownerDatabase.job.create({
      data: jobData(org.id, creator.id, { status: 'ASSIGNED', currentAssigneeId: agent.id }),
    })

    await ownerDatabase.assignment.create({
      data: { organizationId: org.id, jobId: job.id, agentId: agent.id, state: 'DECLINED' },
    })

    await expect(
      ownerDatabase.assignment.create({
        data: { organizationId: org.id, jobId: job.id, agentId: agent.id, state: 'OFFERED' },
      }),
    ).resolves.toBeDefined()
  })
})

describe('JobEvent immutability', () => {
  it('rejects UPDATE of a job event', async () => {
    const org = await createOrg('event-update')
    const creator = await createUser('event-creator@example.test')

    const job = await ownerDatabase.job.create({ data: jobData(org.id, creator.id) })
    const event = await ownerDatabase.jobEvent.create({
      data: {
        organizationId: org.id,
        jobId: job.id,
        actorUserId: creator.id,
        fromStatus: null,
        toStatus: 'PENDING',
        reason: 'Job created',
      },
    })

    await expect(
      ownerDatabase.jobEvent.update({ where: { id: event.id }, data: { reason: 'Edited' } }),
    ).rejects.toThrow(/immutable/)
  })

  it('rejects DELETE of a job event', async () => {
    const org = await createOrg('event-delete')
    const creator = await createUser('event-deleter@example.test')

    const job = await ownerDatabase.job.create({ data: jobData(org.id, creator.id) })
    const event = await ownerDatabase.jobEvent.create({
      data: {
        organizationId: org.id,
        jobId: job.id,
        actorUserId: creator.id,
        fromStatus: null,
        toStatus: 'PENDING',
      },
    })

    await expect(ownerDatabase.jobEvent.delete({ where: { id: event.id } })).rejects.toThrow(
      /immutable/,
    )
  })
})

describe('tenant-leading indexes', () => {
  it('starts every composite tenant index with organizationId', async () => {
    const rows = await ownerDatabase.$queryRaw`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('Job', 'Assignment', 'JobEvent')
        AND indexdef ILIKE '%organizationId%'
    `

    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const columns = row.indexdef.match(/\(([^)]+)\)/)[1]
      expect(columns.split(',')[0].trim().replaceAll('"', '')).toBe('organizationId')
    }
  })

  it('serves the dispatcher board query from the tenant-leading index', async () => {
    const org = await createOrg('board-idx')
    const creator = await createUser('board-creator@example.test')

    const jobs = []
    for (let i = 0; i < 150; i += 1) {
      jobs.push({
        ...jobData(org.id, creator.id),
        reference: `JOB-2026-${String(i).padStart(6, '0')}`,
        status: i % 3 === 0 ? 'PENDING' : 'COMPLETED',
        currentAssigneeId: i % 3 === 0 ? null : creator.id,
        completedAt: i % 3 === 0 ? null : new Date(),
      })
    }
    await ownerDatabase.job.createMany({ data: jobs })

    const plan = await ownerDatabase.$queryRaw`
      EXPLAIN SELECT "id" FROM "Job"
      WHERE "organizationId" = ${org.id}::uuid AND "status" = 'PENDING'::"JobStatus"
      ORDER BY "dueAt" ASC LIMIT 20
    `
    const text = plan.map((row) => row['QUERY PLAN']).join('\n')
    expect(text).toMatch(/Index Scan/)
  })
})
