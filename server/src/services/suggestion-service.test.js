import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { seedDatabase } from '../../prisma/seed.js'
import { prisma } from '../db/client.js'
import { createJob } from './job-service.js'
import { suggestAgents } from './suggestion-service.js'
import { createOwnerTestClient, resetDatabase } from '../test/helpers.js'

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
const adminEmail = 'admin@dispatchgrid.local'
const agentEmail = 'agent@dispatchgrid.local'
const shadowEmail = 'agent@shadow.dispatchgrid.local'

const JOB_LOCATION = { latitude: 51.5, longitude: -0.12 }

function createInput(overrides = {}) {
  return {
    title: 'Fix basement pump',
    latitude: JOB_LOCATION.latitude,
    longitude: JOB_LOCATION.longitude,
    priority: 'HIGH',
    dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  }
}

async function pendingJob(dispatcher, key) {
  const { job } = await createJob(dispatcher, createInput(), { key })
  return job
}

async function createAgentUser(organizationId, tag, overrides = {}) {
  const user = await ownerDatabase.user.create({
    data: {
      email: `suggest-${tag}-${randomUUID()}@example.test`,
      displayName: `Suggest Agent ${tag}`,
      passwordHash: 'test-only-password-hash',
    },
  })
  const role = await ownerDatabase.role.findFirstOrThrow({
    where: { organizationId, name: 'AGENT' },
  })
  await ownerDatabase.membership.create({
    data: {
      organizationId,
      userId: user.id,
      roleId: role.id,
      isAvailable: overrides.isAvailable ?? true,
      concurrentJobCap: overrides.concurrentJobCap ?? null,
    },
  })
  return user
}

async function addActiveAssignments(actor, agentId, count, tag) {
  for (let i = 0; i < count; i += 1) {
    const job = await ownerDatabase.job.create({
      data: {
        organizationId: actor.organizationId,
        reference: `T18-${tag}-${i}-${randomUUID().slice(0, 6)}`,
        title: `Active job ${tag} ${i}`,
        latitude: JOB_LOCATION.latitude,
        longitude: JOB_LOCATION.longitude,
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
        state: i % 2 === 0 ? 'OFFERED' : 'ACCEPTED',
      },
    })
  }
}

async function tableCounts() {
  const [job, assignment, jobEvent, membership] = await Promise.all([
    ownerDatabase.job.count(),
    ownerDatabase.assignment.count(),
    ownerDatabase.jobEvent.count(),
    ownerDatabase.membership.count(),
  ])
  return { job, assignment, jobEvent, membership }
}

function positionsFor(entries) {
  return new Map(entries.map(([userId, position]) => [userId, position]))
}

describe('suggestAgents deterministic read', () => {
  it('requires the assign permission', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await pendingJob(dispatcher, 'suggest-perm')

    const error = await suggestAgents(agent, job.id).catch((e) => e)
    expect(error.code).toBe('forbidden')
  })

  it('returns 404 for another organization job', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const shadow = await buildActor(shadowEmail)
    const { job: shadowJob } = await createJob(
      { ...shadow, permissions: ['job.create'] },
      createInput(),
      { key: 'suggest-shadow-job' },
    )

    const error = await suggestAgents(dispatcher, shadowJob.id).catch((e) => e)
    expect(error.code).toBe('not_found')
  })

  it('excludes non-agent roles', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const admin = await buildActor(adminEmail)
    const job = await pendingJob(dispatcher, 'suggest-role')

    const suggestions = await suggestAgents(dispatcher, job.id)
    const ids = suggestions.map((s) => s.userId)
    expect(ids).not.toContain(dispatcher.userId)
    expect(ids).not.toContain(admin.userId)
  })

  it('excludes unavailable agents', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    await ownerDatabase.membership.updateMany({
      where: { userId: agent.userId },
      data: { isAvailable: false },
    })
    const job = await pendingJob(dispatcher, 'suggest-unavail')

    const suggestions = await suggestAgents(dispatcher, job.id)
    expect(suggestions.map((s) => s.userId)).not.toContain(agent.userId)
  })

  it('excludes agents at the default cap and honors override caps', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    await addActiveAssignments(dispatcher, agent.userId, 3, 'cap')
    const job = await pendingJob(dispatcher, 'suggest-cap')

    const atCap = await suggestAgents(dispatcher, job.id)
    expect(atCap.map((s) => s.userId)).not.toContain(agent.userId)

    await ownerDatabase.membership.updateMany({
      where: { userId: agent.userId },
      data: { concurrentJobCap: 4 },
    })
    const withOverride = await suggestAgents(dispatcher, job.id)
    expect(withOverride.map((s) => s.userId)).toContain(agent.userId)
  })

  it('excludes agents from other organizations', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const shadow = await buildActor(shadowEmail)
    const job = await pendingJob(dispatcher, 'suggest-xorg')

    const suggestions = await suggestAgents(dispatcher, job.id)
    expect(suggestions.map((s) => s.userId)).not.toContain(shadow.userId)
  })

  it('orders known positions by deterministic scoring and breaks ties by userId', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const near = await createAgentUser(dispatcher.organizationId, 'near')
    const far = await createAgentUser(dispatcher.organizationId, 'far')
    const job = await pendingJob(dispatcher, 'suggest-order')

    const positions = positionsFor([
      [near.id, { latitude: JOB_LOCATION.latitude, longitude: JOB_LOCATION.longitude }],
      [far.id, { latitude: 52.5, longitude: -0.12 }],
    ])

    const suggestions = await suggestAgents(dispatcher, job.id, positions)
    const relevant = suggestions.filter((s) => [near.id, far.id].includes(s.userId))
    expect(relevant.map((s) => s.userId)).toEqual([near.id, far.id])
    expect(relevant[0].positionKnown).toBe(true)
    expect(relevant[0].distanceKm).toBeCloseTo(0, 5)
    expect(typeof relevant[1].distanceKm).toBe('number')
    expect(relevant[1].distanceKm).toBeGreaterThan(relevant[0].distanceKm)
    expect(typeof relevant[0].finalScore).toBe('number')

    const again = await suggestAgents(dispatcher, job.id, positions)
    expect(JSON.stringify(again)).toBe(JSON.stringify(suggestions))
  })

  it('prefers lower load at equal distance and keeps ties stable', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const light = await createAgentUser(dispatcher.organizationId, 'light')
    const heavy = await createAgentUser(dispatcher.organizationId, 'heavy')
    await addActiveAssignments(dispatcher, heavy.id, 2, 'heavy')
    const job = await pendingJob(dispatcher, 'suggest-load')

    const sameSpot = { latitude: JOB_LOCATION.latitude, longitude: JOB_LOCATION.longitude }
    const positions = positionsFor([
      [light.id, sameSpot],
      [heavy.id, sameSpot],
    ])

    const suggestions = await suggestAgents(dispatcher, job.id, positions)
    const relevant = suggestions.filter((s) => [light.id, heavy.id].includes(s.userId))
    expect(relevant.map((s) => s.userId)).toEqual([light.id, heavy.id])
    expect(relevant[0].activeJobs).toBe(0)
    expect(relevant[1].activeJobs).toBe(2)

    const twinA = await createAgentUser(dispatcher.organizationId, 'twin-a')
    const twinB = await createAgentUser(dispatcher.organizationId, 'twin-b')
    const tiedPositions = positionsFor([
      [twinA.id, sameSpot],
      [twinB.id, sameSpot],
    ])
    const first = await suggestAgents(dispatcher, job.id, tiedPositions)
    const second = await suggestAgents(dispatcher, job.id, tiedPositions)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    const twins = first.filter((s) => [twinA.id, twinB.id].includes(s.userId))
    const byUserId = [twinA.id, twinB.id].sort((a, b) => String(a).localeCompare(String(b)))
    expect(twins.map((s) => s.userId)).toEqual(byUserId)
  })

  it('appends unknown positions after known ones ordered by load then userId', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const known = await createAgentUser(dispatcher.organizationId, 'known')
    await addActiveAssignments(dispatcher, known.id, 2, 'known')
    const idleUnknown = await createAgentUser(dispatcher.organizationId, 'idle-unknown')
    const busyUnknown = await createAgentUser(dispatcher.organizationId, 'busy-unknown')
    await addActiveAssignments(dispatcher, busyUnknown.id, 1, 'busy')
    const job = await pendingJob(dispatcher, 'suggest-mixed')

    const positions = positionsFor([
      [known.id, { latitude: 53.5, longitude: -0.12 }],
    ])

    const suggestions = await suggestAgents(dispatcher, job.id, positions)
    const relevant = suggestions.filter((s) =>
      [known.id, idleUnknown.id, busyUnknown.id].includes(s.userId),
    )
    expect(relevant.map((s) => s.userId)).toEqual([known.id, idleUnknown.id, busyUnknown.id])

    const [knownEntry, ...unknownEntries] = relevant
    expect(knownEntry.positionKnown).toBe(true)
    expect(typeof knownEntry.distanceKm).toBe('number')
    expect(typeof knownEntry.finalScore).toBe('number')
    for (const entry of unknownEntries) {
      expect(entry.positionKnown).toBe(false)
      expect(entry.distanceKm).toBeNull()
      expect(entry.finalScore).toBeNull()
    }
    expect(unknownEntries.map((s) => s.activeJobs)).toEqual([0, 1])
  })

  it('covers the same eligible set with and without positions', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const extra = await createAgentUser(dispatcher.organizationId, 'seam')
    const job = await pendingJob(dispatcher, 'suggest-seam')

    const without = await suggestAgents(dispatcher, job.id)
    const withPositions = await suggestAgents(
      dispatcher,
      job.id,
      positionsFor(
        without.map((s) => [s.userId, { latitude: 51.5, longitude: -0.12 }]),
      ),
    )

    expect(withPositions.map((s) => s.userId).sort()).toEqual(
      without.map((s) => s.userId).sort(),
    )
    expect(without.map((s) => s.userId)).toContain(extra.id)
    for (const entry of without) {
      expect(entry.positionKnown).toBe(false)
      expect(entry.distanceKm).toBeNull()
      expect(entry.finalScore).toBeNull()
    }
    for (const entry of withPositions) {
      expect(entry.positionKnown).toBe(true)
      expect(typeof entry.distanceKm).toBe('number')
      expect(typeof entry.finalScore).toBe('number')
    }
  })

  it('returns an empty list when nobody is eligible', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    await ownerDatabase.membership.updateMany({
      where: { userId: agent.userId },
      data: { isAvailable: false },
    })
    const job = await pendingJob(dispatcher, 'suggest-empty')

    await expect(suggestAgents(dispatcher, job.id)).resolves.toEqual([])
  })

  it('performs no database writes', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const extra = await createAgentUser(dispatcher.organizationId, 'nowrite')
    const job = await pendingJob(dispatcher, 'suggest-nowrite')
    const positions = positionsFor([
      [extra.id, { latitude: 51.5, longitude: -0.12 }],
    ])

    const before = await tableCounts()
    await suggestAgents(dispatcher, job.id, positions)
    await suggestAgents(dispatcher, job.id)
    const after = await tableCounts()

    expect(after).toEqual(before)
  })
})
