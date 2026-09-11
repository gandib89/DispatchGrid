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
  it('yields one winner and one conflict with a consistent end state', async () => {
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

    const { job } = await createJob(
      dispatcher,
      {
        title: 'Collision job',
        latitude: 1,
        longitude: 1,
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      { key: 'collision-base' },
    )
    await assignJob(dispatcher, job.id, agentA.userId, 1, { key: 'collision-offer' })

    const results = await Promise.allSettled([
      acceptJob(agentA, job.id, { version: 2, key: 'collision-accept' }),
      reassignJob(dispatcher, job.id, agentB.userId, 2, 'Shift change', {
        key: 'collision-reassign',
      }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(['version_conflict', 'invalid_transition', 'already_assigned']).toContain(
      rejected[0].reason.code,
    )

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
  })
})
