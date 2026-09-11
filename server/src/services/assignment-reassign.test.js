import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { seedDatabase } from '../../prisma/seed.js'
import { prisma } from '../db/client.js'
import { createJob } from './job-service.js'
import { assignJob, reassignJob } from './assignment-service.js'
import {
  createOwnerTestClient,
  resetDatabase,
} from '../test/helpers.js'

const ownerDatabase = createOwnerTestClient()

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
  await seedDatabase(ownerDatabase)
})

afterAll(async () => {
  await Promise.all([ownerDatabase.$disconnect(), prisma.$disconnect()])
})

async function buildActor(email) {
  const user = await ownerDatabase.user.findUniqueOrThrow({ where: { email } })
  const membership = await ownerDatabase.membership.findFirstOrThrow({
    where: { userId: user.id },
    include: {
      role: { include: { rolePermissions: { include: { permission: true } } } },
    },
  })
  return {
    userId: user.id,
    organizationId: membership.organizationId,
    membershipId: membership.id,
    permissions: membership.role.rolePermissions.map((link) => link.permission.code),
  }
}

const dispatcherEmail = 'dispatcher@dispatchgrid.local'
const agentEmail = 'agent@dispatchgrid.local'
const shadowEmail = 'agent@shadow.dispatchgrid.local'

function createInput(overrides = {}) {
  return {
    title: 'Fix basement pump',
    latitude: 51.5,
    longitude: -0.12,
    priority: 'HIGH',
    dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  }
}

async function createAvailableAgent(dispatcher, suffix) {
  const user = await ownerDatabase.user.create({
    data: {
      email: `agent-${suffix}@dispatchgrid.local`,
      displayName: `Extra Agent ${suffix}`,
      passwordHash: 'test-only-password-hash',
    },
  })
  const role = await ownerDatabase.role.findFirstOrThrow({
    where: { organizationId: dispatcher.organizationId, name: 'AGENT' },
  })
  await ownerDatabase.membership.create({
    data: {
      organizationId: dispatcher.organizationId,
      userId: user.id,
      roleId: role.id,
      isAvailable: true,
    },
  })
  return user
}

async function assignedJob(dispatcher, agentUserId, key) {
  const { job } = await createJob(dispatcher, createInput(), { key: `${key}-create` })
  const offered = await assignJob(dispatcher, job.id, agentUserId, 1, { key: `${key}-offer` })
  return offered.job
}

const REASON = 'Covering sick leave'

describe('reassignJob', () => {
  it('moves the offer to another agent with version claim and retained history', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agentA = await buildActor(agentEmail)
    const agentB = await createAvailableAgent(dispatcher, 'b')
    const job = await assignedJob(dispatcher, agentA.userId, 'reassign-happy')

    const { job: reassigned, assignment, replay } = await reassignJob(
      dispatcher,
      job.id,
      agentB.id,
      2,
      REASON,
      { key: 'reassign-happy-key' },
    )

    expect(replay).toBe(false)
    expect(reassigned.status).toBe('ASSIGNED')
    expect(reassigned.version).toBe(3)
    expect(reassigned.currentAssigneeId).toBe(agentB.id)
    expect(assignment.state).toBe('OFFERED')
    expect(assignment.jobId).toBe(job.id)
    expect(assignment.agentId).toBe(agentB.id)

    const history = await ownerDatabase.assignment.findMany({
      where: { jobId: job.id },
      orderBy: { createdAt: 'asc' },
    })
    expect(history).toHaveLength(2)
    expect(history[0].agentId).toBe(agentA.userId)
    expect(history[0].state).toBe('REVOKED')
    expect(history[1].agentId).toBe(agentB.id)
    expect(history[1].state).toBe('OFFERED')

    const events = await ownerDatabase.jobEvent.findMany({
      where: { jobId: job.id },
      orderBy: { createdAt: 'asc' },
    })
    const reassignedEvent = events.at(-1)
    expect(reassignedEvent.fromStatus).toBe('ASSIGNED')
    expect(reassignedEvent.toStatus).toBe('ASSIGNED')
    expect(reassignedEvent.reason).toBe(REASON)
  })

  it('requires a non-empty reason', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agentA = await buildActor(agentEmail)
    const agentB = await createAvailableAgent(dispatcher, 'reason')
    const job = await assignedJob(dispatcher, agentA.userId, 'reassign-reason')

    for (const badReason of ['', '   ', null, undefined]) {
      const error = await reassignJob(dispatcher, job.id, agentB.id, 2, badReason, {
        key: `reassign-reason-${String(badReason)}`,
      }).catch((e) => e)
      expect(error.code).toBe('validation_error')
      expect(error.status).toBe(400)
    }
  })

  it('conflicts on a stale version with current state attached', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agentA = await buildActor(agentEmail)
    const agentB = await createAvailableAgent(dispatcher, 'stale')
    const job = await assignedJob(dispatcher, agentA.userId, 'reassign-stale')

    const error = await reassignJob(dispatcher, job.id, agentB.id, 1, REASON, {
      key: 'reassign-stale-key',
    }).catch((e) => e)
    expect(error.code).toBe('version_conflict')
    expect(error.details.currentVersion).toBe(2)
    expect(error.details.currentStatus).toBe('ASSIGNED')
  })

  it('refuses to reassign a job that is not assigned', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agentA = await buildActor(agentEmail)
    const { job } = await createJob(dispatcher, createInput(), { key: 'reassign-pending' })

    const error = await reassignJob(dispatcher, job.id, agentA.userId, 1, REASON, {
      key: 'reassign-pending-key',
    }).catch((e) => e)
    expect(error.code).toBe('invalid_transition')
  })

  it('refuses an ineligible or over-cap target agent', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agentA = await buildActor(agentEmail)
    const job = await assignedJob(dispatcher, agentA.userId, 'reassign-elig')

    await ownerDatabase.membership.updateMany({
      where: { userId: agentA.userId },
      data: { isAvailable: false },
    })
    const unavailableAgent = await createAvailableAgent(dispatcher, 'unavail')
    await ownerDatabase.membership.updateMany({
      where: { userId: unavailableAgent.id },
      data: { isAvailable: false },
    })
    const unavailable = await reassignJob(dispatcher, job.id, unavailableAgent.id, 2, REASON, {
      key: 'reassign-unavail',
    }).catch((e) => e)
    expect(unavailable.code).toBe('agent_not_eligible')
    expect(unavailable.details.reasons).toContain('unavailable')

    const wrongRole = await reassignJob(dispatcher, job.id, dispatcher.userId, 2, REASON, {
      key: 'reassign-role',
    }).catch((e) => e)
    expect(wrongRole.code).toBe('agent_not_eligible')
    expect(wrongRole.details.reasons).toContain('wrong_role')

    const shadow = await buildActor(shadowEmail)
    const crossOrg = await reassignJob(dispatcher, job.id, shadow.userId, 2, REASON, {
      key: 'reassign-xorg-agent',
    }).catch((e) => e)
    expect(crossOrg.code).toBe('agent_not_eligible')
    expect(crossOrg.details.reasons).toContain('wrong_organization')
  })

  it('refuses an over-cap target agent', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agentA = await buildActor(agentEmail)
    const agentB = await createAvailableAgent(dispatcher, 'cap')
    const job = await assignedJob(dispatcher, agentA.userId, 'reassign-cap')

    for (let i = 0; i < 3; i += 1) {
      const filler = await ownerDatabase.job.create({
        data: {
          organizationId: dispatcher.organizationId,
          reference: `JOB-2026-009${i}`,
          title: `Filler job ${i}`,
          latitude: 51.5,
          longitude: -0.12,
          status: 'ASSIGNED',
          currentAssigneeId: agentB.id,
          createdById: dispatcher.userId,
          version: 2,
          dueAt: new Date(Date.now() + 3_600_000),
        },
      })
      await ownerDatabase.assignment.create({
        data: {
          organizationId: dispatcher.organizationId,
          jobId: filler.id,
          agentId: agentB.id,
          state: 'OFFERED',
        },
      })
    }

    const error = await reassignJob(dispatcher, job.id, agentB.id, 2, REASON, {
      key: 'reassign-cap-key',
    }).catch((e) => e)
    expect(error.code).toBe('agent_not_eligible')
    expect(error.details.reasons).toContain('at_cap')
  })

  it('denies reassign without the assign permission', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agentA = await buildActor(agentEmail)
    const agentB = await createAvailableAgent(dispatcher, 'perm')
    const job = await assignedJob(dispatcher, agentA.userId, 'reassign-perm')

    const error = await reassignJob(agentA, job.id, agentB.id, 2, REASON, {
      key: 'reassign-perm-key',
    }).catch((e) => e)
    expect(error.code).toBe('forbidden')
  })

  it('returns 404 for another organization’s job', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agentA = await buildActor(agentEmail)
    const agentB = await createAvailableAgent(dispatcher, 'xorg')
    const shadow = await buildActor(shadowEmail)
    const { job: shadowJob } = await createJob(
      { ...shadow, permissions: ['job.create'] },
      createInput(),
      { key: 'reassign-shadow-job' },
    )

    const error = await reassignJob(dispatcher, shadowJob.id, agentB.id, 1, REASON, {
      key: 'reassign-shadow-key',
    }).catch((e) => e)
    expect(error.code).toBe('not_found')
    expect(agentA.userId).toBeDefined()
  })

  it('replays the identical reassign for the same key', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agentA = await buildActor(agentEmail)
    const agentB = await createAvailableAgent(dispatcher, 'replay')
    const job = await assignedJob(dispatcher, agentA.userId, 'reassign-replay')

    const first = await reassignJob(dispatcher, job.id, agentB.id, 2, REASON, {
      key: 'reassign-replay-key',
    })
    const second = await reassignJob(dispatcher, job.id, agentB.id, 2, REASON, {
      key: 'reassign-replay-key',
    })

    expect(second.replay).toBe(true)
    expect(second.job).toEqual(first.job)
    expect(await ownerDatabase.assignment.count({ where: { jobId: job.id } })).toBe(2)
  })

  it('lets exactly one parallel reassign win with the same version', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agentA = await buildActor(agentEmail)
    const agentB = await createAvailableAgent(dispatcher, 'race-b')
    const agentC = await createAvailableAgent(dispatcher, 'race-c')
    const job = await assignedJob(dispatcher, agentA.userId, 'reassign-race')

    const outcomes = await Promise.allSettled([
      reassignJob(dispatcher, job.id, agentB.id, 2, 'First mover'),
      reassignJob(dispatcher, job.id, agentC.id, 2, 'Second mover'),
    ])

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled')
    const rejected = outcomes.filter((o) => o.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason.code).toBe('version_conflict')

    const refreshed = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(refreshed.version).toBe(3)
    expect([agentB.id, agentC.id]).toContain(refreshed.currentAssigneeId)

    const active = await ownerDatabase.assignment.findMany({
      where: { jobId: job.id, state: { in: ['OFFERED', 'ACCEPTED'] } },
    })
    expect(active).toHaveLength(1)
    expect(active[0].agentId).toBe(refreshed.currentAssigneeId)
    expect(await ownerDatabase.assignment.count({ where: { jobId: job.id } })).toBe(2)
  })
})
