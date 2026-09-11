import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { seedDatabase } from '../../prisma/seed.js'
import { prisma } from '../db/client.js'
import { createJob } from './job-service.js'
import { acceptJob, assignJob, declineJob } from './assignment-service.js'
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

async function buildSecondAgent(dispatcher, email) {
  const role = await ownerDatabase.role.findFirstOrThrow({
    where: { organizationId: dispatcher.organizationId, name: 'AGENT' },
  })
  const user = await ownerDatabase.user.create({
    data: {
      email,
      displayName: 'Second Field Agent',
      passwordHash: 'test-only-password-hash',
    },
  })
  await ownerDatabase.membership.create({
    data: {
      organizationId: dispatcher.organizationId,
      userId: user.id,
      roleId: role.id,
      isAvailable: true,
    },
  })
  return buildActor(email)
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

async function offeredJob(dispatcher, agent, keySuffix) {
  const { job: created } = await createJob(dispatcher, createInput(), { key: `respond-base-${keySuffix}` })
  const { job } = await assignJob(dispatcher, created.id, agent.userId, 1, {
    key: `respond-offer-${keySuffix}`,
  })
  return job
}

describe('acceptJob', () => {
  it('accepts the owned offer atomically with version claim and event', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await offeredJob(dispatcher, agent, 'accept-ok')

    const { job: accepted, assignment, replay } = await acceptJob(agent, job.id, {
      version: 2,
      key: 'accept-ok',
    })

    expect(replay).toBe(false)
    expect(accepted.status).toBe('ACCEPTED')
    expect(accepted.version).toBe(3)
    expect(accepted.currentAssigneeId).toBe(agent.userId)
    expect(assignment.state).toBe('ACCEPTED')
    expect(assignment.jobId).toBe(job.id)
    expect(assignment.agentId).toBe(agent.userId)

    const events = await ownerDatabase.jobEvent.findMany({ where: { jobId: job.id } })
    const acceptEvents = events.filter((event) => event.toStatus === 'ACCEPTED')
    expect(acceptEvents).toHaveLength(1)
    expect(acceptEvents[0].fromStatus).toBe('ASSIGNED')
  })

  it('denies an agent touching another agent’s offer', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const other = await buildSecondAgent(dispatcher, 'agent-2@dispatchgrid.local')
    const job = await offeredJob(dispatcher, agent, 'accept-cross')

    const error = await acceptJob(other, job.id, { version: 2, key: 'accept-cross' }).catch(
      (caught) => caught,
    )
    // Lost race surfaces as 409 with current state, not 403: the probe
    // learns the job moved so it can re-read and retry elsewhere.
    expect(error.code).toBe('version_conflict')
    expect(error.status).toBe(409)
    expect(error.details.currentVersion).toBe(2)
    expect(error.details.currentStatus).toBe('ASSIGNED')

    const fresh = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(fresh.status).toBe('ASSIGNED')
    expect(
      await ownerDatabase.assignment.count({ where: { jobId: job.id, state: 'OFFERED' } }),
    ).toBe(1)
  })

  it('rejects accepting a non-offered assignment as invalid_transition', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await offeredJob(dispatcher, agent, 'accept-twice')

    await acceptJob(agent, job.id, { version: 2, key: 'accept-twice-ok' })
    const second = await acceptJob(agent, job.id, { version: 3, key: 'accept-twice-again' }).catch(
      (caught) => caught,
    )
    expect(second.code).toBe('invalid_transition')
  })

  it('rejects accepting a revoked offer as invalid_transition', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await offeredJob(dispatcher, agent, 'accept-revoked')

    await ownerDatabase.assignment.updateMany({
      where: { jobId: job.id, state: 'OFFERED' },
      data: { state: 'REVOKED' },
    })

    const error = await acceptJob(agent, job.id, { version: 2, key: 'accept-revoked' }).catch(
      (caught) => caught,
    )
    expect(error.code).toBe('invalid_transition')
  })

  it('conflicts on a stale version with current state attached', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await offeredJob(dispatcher, agent, 'accept-stale')
    await ownerDatabase.job.update({
      where: { id: job.id },
      data: { title: 'Edited elsewhere', version: 3 },
    })

    const error = await acceptJob(agent, job.id, { version: 2, key: 'accept-stale' }).catch(
      (caught) => caught,
    )
    expect(error.code).toBe('version_conflict')
    expect(error.details.currentVersion).toBe(3)
    expect(error.details.currentStatus).toBe('ASSIGNED')

    const fresh = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(fresh.status).toBe('ASSIGNED')
    expect(
      await ownerDatabase.assignment.count({ where: { jobId: job.id, state: 'OFFERED' } }),
    ).toBe(1)
  })

  it('denies accept without the respond permission', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await offeredJob(dispatcher, agent, 'accept-perm')

    const error = await acceptJob(dispatcher, job.id, { version: 2, key: 'accept-perm' }).catch(
      (caught) => caught,
    )
    expect(error.code).toBe('forbidden')
  })

  it('returns 404 for another organization’s job', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const shadow = await buildActor(shadowEmail)
    const job = await offeredJob(dispatcher, agent, 'accept-xorg')

    const error = await acceptJob(shadow, job.id, { version: 2, key: 'accept-xorg' }).catch(
      (caught) => caught,
    )
    expect(error.code).toBe('not_found')
  })

  it('replays the identical accept for the same key', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await offeredJob(dispatcher, agent, 'accept-replay')

    const first = await acceptJob(agent, job.id, { version: 2, key: 'accept-replay-key' })
    const second = await acceptJob(agent, job.id, { version: 2, key: 'accept-replay-key' })

    expect(second.replay).toBe(true)
    expect(second.job).toEqual(first.job)
    expect(second.assignment).toEqual(first.assignment)
    const events = await ownerDatabase.jobEvent.findMany({
      where: { jobId: job.id, toStatus: 'ACCEPTED' },
    })
    expect(events).toHaveLength(1)
  })
})

describe('declineJob', () => {
  it('declines the owned offer, clears the assignee, and returns the job to pending', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await offeredJob(dispatcher, agent, 'decline-ok')

    const { job: declined, assignment, replay } = await declineJob(agent, job.id, {
      version: 2,
      key: 'decline-ok',
    })

    expect(replay).toBe(false)
    expect(declined.status).toBe('PENDING')
    expect(declined.version).toBe(3)
    expect(declined.currentAssigneeId).toBeNull()
    expect(assignment.state).toBe('DECLINED')
    expect(assignment.jobId).toBe(job.id)

    const events = await ownerDatabase.jobEvent.findMany({ where: { jobId: job.id } })
    const declineEvents = events.filter(
      (event) => event.fromStatus === 'ASSIGNED' && event.toStatus === 'PENDING',
    )
    expect(declineEvents).toHaveLength(1)
    expect(declineEvents[0].fromStatus).toBe('ASSIGNED')
    expect(
      await ownerDatabase.assignment.count({
        where: { jobId: job.id, state: { in: ['OFFERED', 'ACCEPTED'] } },
      }),
    ).toBe(0)
  })

  it('denies an agent declining another agent’s offer', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const other = await buildSecondAgent(dispatcher, 'agent-2@dispatchgrid.local')
    const job = await offeredJob(dispatcher, agent, 'decline-cross')

    const error = await declineJob(other, job.id, { version: 2, key: 'decline-cross' }).catch(
      (caught) => caught,
    )
    // Lost race surfaces as 409 with current state, not 403.
    expect(error.code).toBe('version_conflict')
    expect(error.status).toBe(409)
    expect(error.details.currentVersion).toBe(2)
    expect(error.details.currentStatus).toBe('ASSIGNED')

    const fresh = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(fresh.status).toBe('ASSIGNED')
    expect(fresh.currentAssigneeId).toBe(agent.userId)
  })

  it('rejects declining after the offer was already accepted', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await offeredJob(dispatcher, agent, 'decline-after-accept')

    await acceptJob(agent, job.id, { version: 2, key: 'decline-after-accept-ok' })
    const error = await declineJob(agent, job.id, { version: 3, key: 'decline-after-accept' }).catch(
      (caught) => caught,
    )
    expect(error.code).toBe('invalid_transition')
  })

  it('conflicts on a stale version with current state attached', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await offeredJob(dispatcher, agent, 'decline-stale')
    await ownerDatabase.job.update({
      where: { id: job.id },
      data: { title: 'Edited elsewhere', version: 3 },
    })

    const error = await declineJob(agent, job.id, { version: 2, key: 'decline-stale' }).catch(
      (caught) => caught,
    )
    expect(error.code).toBe('version_conflict')
    expect(error.details.currentVersion).toBe(3)
    expect(error.details.currentStatus).toBe('ASSIGNED')
  })

  it('denies decline without the respond permission', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await offeredJob(dispatcher, agent, 'decline-perm')

    const error = await declineJob(dispatcher, job.id, { version: 2, key: 'decline-perm' }).catch(
      (caught) => caught,
    )
    expect(error.code).toBe('forbidden')
  })

  it('replays the identical decline for the same key', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await offeredJob(dispatcher, agent, 'decline-replay')

    const first = await declineJob(agent, job.id, { version: 2, key: 'decline-replay-key' })
    const second = await declineJob(agent, job.id, { version: 2, key: 'decline-replay-key' })

    expect(second.replay).toBe(true)
    expect(second.job).toEqual(first.job)
    expect(second.assignment).toEqual(first.assignment)
    const events = await ownerDatabase.jobEvent.findMany({
      where: { jobId: job.id, fromStatus: 'ASSIGNED', toStatus: 'PENDING' },
    })
    expect(events).toHaveLength(1)
  })
})
