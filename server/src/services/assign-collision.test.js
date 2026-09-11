import crypto from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedDatabase } from '../../prisma/seed.js'
import { createJob } from './job-service.js'
import { acceptJob, assignJob } from './assignment-service.js'
import { reassignJob } from './assignment-service.js'
import {
  createOwnerTestClient,
  resetDatabase,
} from '../test/helpers.js'

const ownerDatabase = createOwnerTestClient()

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
  await seedDatabase(ownerDatabase)
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

describe('reassign vs accept collision', () => {
  it.each([1, 2, 3, 4, 5])(
    'yields one winner and one 409-family conflict with a consistent end state (run %s/5)',
    async () => {
      const dispatcher = await buildActor('dispatcher@dispatchgrid.local')
      const agentA = await buildActor('agent@dispatchgrid.local')
      const agentB = await buildActor('admin@dispatchgrid.local')

      const agentRole = await ownerDatabase.role.findFirstOrThrow({
        where: { organizationId: dispatcher.organizationId, name: 'AGENT' },
      })
      const membershipB = await ownerDatabase.membership.findFirstOrThrow({
        where: { userId: agentB.userId },
      })
      await ownerDatabase.membership.update({
        where: { id: membershipB.id },
        data: { roleId: agentRole.id, isAvailable: true },
      })

      const runKey = crypto.randomUUID()
      const { job } = await createJob(
        dispatcher,
        {
          title: 'Collision job',
          latitude: 1,
          longitude: 1,
          dueAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        { key: `collision-base-${runKey}` },
      )
      await assignJob(dispatcher, job.id, agentA.userId, 1, { key: `collision-offer-${runKey}` })

      const results = await Promise.allSettled([
        acceptJob(agentA, job.id, { version: 2, key: `collision-accept-${runKey}` }),
        reassignJob(dispatcher, job.id, agentB.userId, 2, 'Shift change', {
          key: `collision-reassign-${runKey}`,
        }),
      ])
      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')

      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      // Losers are 409-family only: version_conflict (stale claim / lost
      // race) or already_assigned (partial-index backstop).
      expect(['version_conflict', 'already_assigned']).toContain(rejected[0].reason.code)
      expect(rejected[0].reason.status).toBe(409)

      const finalJob = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
      const active = await ownerDatabase.assignment.findMany({
        where: { jobId: job.id, state: { in: ['OFFERED', 'ACCEPTED'] } },
      })
      expect(active).toHaveLength(1)
      if (finalJob.status === 'ACCEPTED') {
        expect(finalJob.currentAssigneeId).toBe(agentA.userId)
        expect(active[0].agentId).toBe(agentA.userId)
      } else {
        expect(finalJob.status).toBe('ASSIGNED')
        expect(finalJob.currentAssigneeId).toBe(agentB.userId)
        expect(active[0].agentId).toBe(agentB.userId)
      }
    },
  )

  it('records the full ordered timeline for sequential offer -> reassign -> accept', async () => {
    const dispatcher = await buildActor('dispatcher@dispatchgrid.local')
    const agentA = await buildActor('agent@dispatchgrid.local')
    const agentB = await buildActor('admin@dispatchgrid.local')

    const agentRole = await ownerDatabase.role.findFirstOrThrow({
      where: { organizationId: dispatcher.organizationId, name: 'AGENT' },
    })
    const membershipB = await ownerDatabase.membership.findFirstOrThrow({
      where: { userId: agentB.userId },
    })
    await ownerDatabase.membership.update({
      where: { id: membershipB.id },
      data: { roleId: agentRole.id, isAvailable: true },
    })

    const { job: created } = await createJob(
      dispatcher,
      {
        title: 'Timeline job',
        latitude: 1,
        longitude: 1,
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      { key: 'timeline-base' },
    )
    const offered = await assignJob(dispatcher, created.id, agentA.userId, 1, {
      key: 'timeline-offer',
    })
    expect(offered.job.status).toBe('ASSIGNED')
    const reassigned = await reassignJob(dispatcher, created.id, agentB.userId, 2, 'Shift change', {
      key: 'timeline-reassign',
    })
    expect(reassigned.job.status).toBe('ASSIGNED')
    expect(reassigned.job.version).toBe(3)
    const accepted = await acceptJob(agentB, created.id, { version: 3, key: 'timeline-accept' })
    expect(accepted.job.status).toBe('ACCEPTED')
    expect(accepted.job.version).toBe(4)

    const events = await ownerDatabase.jobEvent.findMany({
      where: { jobId: created.id },
      orderBy: { createdAt: 'asc' },
    })
    expect(events.map((e) => e.toStatus)).toEqual(['PENDING', 'ASSIGNED', 'ASSIGNED', 'ACCEPTED'])
    expect(events[0].actorUserId).toBe(dispatcher.userId)
    expect(events[1].actorUserId).toBe(dispatcher.userId)
    expect(events[1].reason).toBe('Agent offered')
    expect(events[2].actorUserId).toBe(dispatcher.userId)
    expect(events[2].reason).toBe('Shift change')
    expect(events[3].actorUserId).toBe(agentB.userId)
    expect(events[3].reason).toBe('Agent accepted')

    const rows = await ownerDatabase.assignment.findMany({
      where: { jobId: created.id },
      orderBy: { createdAt: 'asc' },
    })
    expect(rows).toHaveLength(2)
    expect(rows[0].agentId).toBe(agentA.userId)
    expect(rows[0].state).toBe('REVOKED')
    expect(rows[1].agentId).toBe(agentB.userId)
    expect(rows[1].state).toBe('ACCEPTED')
  })
})
