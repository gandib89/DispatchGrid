import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { seedDatabase } from '../../prisma/seed.js'
import { prisma } from '../db/client.js'
import { createJob } from './job-service.js'
import { assignJob } from './assignment-service.js'
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

async function pendingJob(dispatcher, key) {
  const { job } = await createJob(dispatcher, createInput(), { key })
  return job
}

async function activeAssignmentsFor(actor, agentId, count) {
  for (let i = 0; i < count; i += 1) {
    const job = await ownerDatabase.job.create({
      data: {
        organizationId: actor.organizationId,
        reference: `JOB-2026-0002${String(i).padStart(2, '0')}`,
        title: `Active job ${i}`,
        latitude: 51.5,
        longitude: -0.12,
        status: 'ASSIGNED',
        currentAssigneeId: agentId,
        createdById: actor.userId,
        version: 2,
        dueAt: new Date(Date.now() + 3_600_000),
      },
    })
    await ownerDatabase.assignment.create({
      data: {
        organizationId: actor.organizationId,
        jobId: job.id,
        agentId,
        state: i === 0 ? 'ACCEPTED' : 'OFFERED',
      },
    })
  }
}

describe('assignJob offer path', () => {
  it('offers an eligible agent atomically with version claim', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await pendingJob(dispatcher, 'offer-base')

    const { job: assigned, assignment, replay } = await assignJob(
      dispatcher,
      job.id,
      agent.userId,
      1,
      { key: 'offer-1' },
    )

    expect(replay).toBe(false)
    expect(assigned.status).toBe('ASSIGNED')
    expect(assigned.version).toBe(2)
    expect(assigned.currentAssigneeId).toBe(agent.userId)
    expect(assignment.state).toBe('OFFERED')
    expect(assignment.jobId).toBe(job.id)

    const events = await ownerDatabase.jobEvent.findMany({ where: { jobId: job.id } })
    expect(events.map((e) => e.toStatus)).toContain('ASSIGNED')
  })

  it('refuses an agent from another organization', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const shadow = await buildActor(shadowEmail)
    const job = await pendingJob(dispatcher, 'offer-xorg')

    const error = await assignJob(dispatcher, job.id, shadow.userId, 1, { key: 'offer-xorg-2' }).catch(
      (e) => e,
    )
    expect(error.code).toBe('agent_not_eligible')
    expect(error.details.reasons).toContain('wrong_organization')
  })

  it('refuses a non-agent role and an unavailable agent', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await pendingJob(dispatcher, 'offer-role')

    const roleError = await assignJob(dispatcher, job.id, dispatcher.userId, 1, {
      key: 'offer-role-2',
    }).catch((e) => e)
    expect(roleError.code).toBe('agent_not_eligible')
    expect(roleError.details.reasons).toContain('wrong_role')

    await ownerDatabase.membership.updateMany({
      where: { userId: agent.userId },
      data: { isAvailable: false },
    })
    const availabilityError = await assignJob(dispatcher, job.id, agent.userId, 1, {
      key: 'offer-avail',
    }).catch((e) => e)
    expect(availabilityError.code).toBe('agent_not_eligible')
    expect(availabilityError.details.reasons).toContain('unavailable')
  })

  it('refuses an agent exactly at the default cap and at an override cap', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    await activeAssignmentsFor(dispatcher, agent.userId, 3)
    const job = await pendingJob(dispatcher, 'offer-cap')

    const atCap = await assignJob(dispatcher, job.id, agent.userId, 1, { key: 'offer-cap-2' }).catch(
      (e) => e,
    )
    expect(atCap.code).toBe('agent_not_eligible')
    expect(atCap.details.reasons).toContain('at_cap')

    await ownerDatabase.membership.updateMany({
      where: { userId: agent.userId },
      data: { concurrentJobCap: 4 },
    })
    const { job: assigned } = await assignJob(dispatcher, job.id, agent.userId, 1, {
      key: 'offer-override',
    })
    expect(assigned.status).toBe('ASSIGNED')
  })

  it('conflicts on a stale version with current state attached', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const { job } = await createJob(dispatcher, createInput(), { key: 'offer-stale-base' })
    await ownerDatabase.job.update({
      where: { id: job.id },
      data: { title: 'Edited elsewhere', version: 2 },
    })

    const error = await assignJob(dispatcher, job.id, agent.userId, 1, { key: 'offer-stale' }).catch(
      (e) => e,
    )
    expect(error.code).toBe('version_conflict')
    expect(error.details.currentVersion).toBe(2)
  })

  it('maps a duplicate active assignment to already_assigned', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await pendingJob(dispatcher, 'offer-dup-base')
    await ownerDatabase.assignment.create({
      data: {
        organizationId: dispatcher.organizationId,
        jobId: job.id,
        agentId: agent.userId,
        state: 'OFFERED',
      },
    })

    const error = await assignJob(dispatcher, job.id, agent.userId, 1, { key: 'offer-dup' }).catch(
      (e) => e,
    )
    expect(error.code).toBe('already_assigned')
  })

  it('denies assignment without the assign permission', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await pendingJob(dispatcher, 'offer-perm')

    const error = await assignJob(agent, job.id, agent.userId, 1, { key: 'offer-perm-2' }).catch(
      (e) => e,
    )
    expect(error.code).toBe('forbidden')
  })

  it('returns 404 for another organization’s job', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const shadow = await buildActor(shadowEmail)
    const { job: shadowJob } = await createJob(
      { ...shadow, permissions: ['job.create'] },
      createInput(),
      { key: 'offer-shadow-job' },
    )

    const error = await assignJob(dispatcher, shadowJob.id, agent.userId, 1, {
      key: 'offer-shadow-2',
    }).catch((e) => e)
    expect(error.code).toBe('not_found')
  })

  it('replays the identical offer for the same key', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await pendingJob(dispatcher, 'offer-replay-base')

    const first = await assignJob(dispatcher, job.id, agent.userId, 1, { key: 'offer-replay' })
    const second = await assignJob(dispatcher, job.id, agent.userId, 1, { key: 'offer-replay' })

    expect(second.replay).toBe(true)
    expect(second.job).toEqual(first.job)
    expect(await ownerDatabase.assignment.count({ where: { jobId: job.id } })).toBe(1)
  })
})
