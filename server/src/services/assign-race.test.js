import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { seedDatabase } from '../../prisma/seed.js'
import { prisma } from '../db/client.js'
import { createJob } from './job-service.js'
import { assignJob, acceptJob, declineJob } from './assignment-service.js'
import { createOwnerTestClient, resetDatabase } from '../test/helpers.js'

// [B09-T2] Two-dispatcher race proof. Service seam against real PostgreSQL.
// Simultaneous starts via Promise.all/allSettled with no sleeps; every attempt
// carries a unique idempotency key so the idempotency layer never masks the
// version/partial-index race. Reassign-vs-accept is explicitly out of scope
// (T4 builds reassign; the merger covers that combination later).

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

function uniqueKey(prefix) {
  return `${prefix}-${crypto.randomUUID()}`
}

async function pendingJob(dispatcher, key) {
  const { job } = await createJob(dispatcher, createInput(), { key })
  return job
}

// Direct durable fixture: an ASSIGNED job with one active assignment row.
async function seedActiveAssignment(actor, agentId, reference, state = 'OFFERED') {
  const job = await ownerDatabase.job.create({
    data: {
      organizationId: actor.organizationId,
      reference,
      title: `Active ${reference}`,
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
      state,
    },
  })
  return job
}

async function activeAssignmentCountForJob(jobId) {
  return ownerDatabase.assignment.count({
    where: { jobId, state: { in: ['OFFERED', 'ACCEPTED'] } },
  })
}

async function activeAssignmentCountForAgent(organizationId, agentId) {
  return ownerDatabase.assignment.count({
    where: { organizationId, agentId, state: { in: ['OFFERED', 'ACCEPTED'] } },
  })
}

// Impossible-pair invariant derived from the B07 CHECKs:
// PENDING/CANCELLED carry no assignee; every other status carries one;
// COMPLETED iff completedAt is set.
function assertPossiblePair(job) {
  const needsAssignee = ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED'].includes(
    job.status,
  )
  const forbidsAssignee = ['PENDING', 'CANCELLED'].includes(job.status)
  if (needsAssignee) {
    expect(
      job.currentAssigneeId,
      `job ${job.reference} status ${job.status} must carry an assignee`,
    ).not.toBeNull()
  }
  if (forbidsAssignee) {
    expect(
      job.currentAssigneeId,
      `job ${job.reference} status ${job.status} must not carry an assignee`,
    ).toBeNull()
  }
  if (job.status === 'COMPLETED') {
    expect(job.completedAt, `job ${job.reference} COMPLETED must carry completedAt`).not.toBeNull()
  } else {
    expect(job.completedAt, `job ${job.reference} ${job.status} must not carry completedAt`).toBeNull()
  }
  expect(job.version).toBeGreaterThanOrEqual(1)
}

// Deterministic PRNG (mulberry32) so the property test is CI-repeatable.
function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('assign race proof (B09-T2)', () => {
  it('collapses two simultaneous assigns with the same version to one winner and one 409', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await pendingJob(dispatcher, uniqueKey('race-base'))

    // Simultaneous start, no sleeps. Unique keys keep idempotency out of the race.
    const settlements = await Promise.allSettled([
      assignJob(dispatcher, job.id, agent.userId, 1, { key: uniqueKey('race-a') }),
      assignJob(dispatcher, job.id, agent.userId, 1, { key: uniqueKey('race-b') }),
    ])

    const winners = settlements.filter((s) => s.status === 'fulfilled')
    const losers = settlements.filter((s) => s.status === 'rejected')
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)

    const won = winners[0].value
    expect(won.job.status).toBe('ASSIGNED')
    expect(won.job.version).toBe(2)
    expect(won.job.currentAssigneeId).toBe(agent.userId)
    expect(won.assignment.state).toBe('OFFERED')

    const lost = losers[0].reason
    // Version claim fires first under the race; the partial unique index is the
    // backstop, so either 409 code proves exactly-once collapse.
    expect(['version_conflict', 'already_assigned']).toContain(lost.code)
    expect(lost.status).toBe(409)
    if (lost.code === 'version_conflict') {
      expect(lost.details.currentVersion).toBe(2)
      expect(lost.details.currentStatus).toBe('ASSIGNED')
    }

    // Exactly one active assignment row remains, agreeing with the job.
    expect(await activeAssignmentCountForJob(job.id)).toBe(1)
    const [active] = await ownerDatabase.assignment.findMany({
      where: { jobId: job.id, state: { in: ['OFFERED', 'ACCEPTED'] } },
    })
    const fresh = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(active.agentId).toBe(agent.userId)
    expect(fresh.currentAssigneeId).toBe(active.agentId)
    expect(fresh.status).toBe('ASSIGNED')
    assertPossiblePair(fresh)
  })

  it('never exceeds the agent cap under two simultaneous cap-sensitive assigns', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)

    // Default cap is 3. Pre-fill 2 so exactly one slot remains.
    await seedActiveAssignment(dispatcher, agent.userId, 'JOB-2026-009101', 'OFFERED')
    await seedActiveAssignment(dispatcher, agent.userId, 'JOB-2026-009102', 'ACCEPTED')

    const first = await pendingJob(dispatcher, uniqueKey('cap-base-a'))
    const second = await pendingJob(dispatcher, uniqueKey('cap-base-b'))

    const settlements = await Promise.allSettled([
      assignJob(dispatcher, first.id, agent.userId, 1, { key: uniqueKey('cap-a') }),
      assignJob(dispatcher, second.id, agent.userId, 1, { key: uniqueKey('cap-b') }),
    ])

    const winners = settlements.filter((s) => s.status === 'fulfilled')
    const losers = settlements.filter((s) => s.status === 'rejected')
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0].reason.code).toBe('agent_not_eligible')
    expect(losers[0].reason.details.reasons).toContain('at_cap')

    // The cap is never exceeded: exactly 3 active rows for the agent.
    expect(await activeAssignmentCountForAgent(dispatcher.organizationId, agent.userId)).toBe(3)

    // Both jobs remain internally consistent; winner ASSIGNED, loser PENDING.
    const jobs = await ownerDatabase.job.findMany({
      where: { id: { in: [first.id, second.id] } },
    })
    for (const job of jobs) {
      assertPossiblePair(job)
      const activeCount = await activeAssignmentCountForJob(job.id)
      if (job.status === 'ASSIGNED') {
        expect(activeCount).toBe(1)
      } else {
        expect(job.status).toBe('PENDING')
        expect(activeCount).toBe(0)
      }
    }
  })

  it('never produces an impossible status/assignee pair across generated attempts', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)

    // Second agent in the same org for cross-agent attempt variety.
    const agentRole = await ownerDatabase.role.findFirstOrThrow({
      where: { organizationId: dispatcher.organizationId, name: 'AGENT' },
    })
    const extraUser = await ownerDatabase.user.create({
      data: {
        email: `extra-${crypto.randomUUID()}@example.test`,
        displayName: 'Extra Agent',
        passwordHash: 'test-only-password-hash',
      },
    })
    await ownerDatabase.membership.create({
      data: {
        organizationId: dispatcher.organizationId,
        userId: extraUser.id,
        roleId: agentRole.id,
        isAvailable: true,
      },
    })
    const extraAgent = await buildActor(extraUser.email)
    const agentIds = [agent.userId, extraUser.id]
    const agentActors = [agent, extraAgent]

    const jobCount = 6
    const jobs = []
    for (let i = 0; i < jobCount; i += 1) {
      jobs.push(await pendingJob(dispatcher, uniqueKey(`prop-base-${i}`)))
    }

    const random = mulberry32(0xb09)
    const attempts = 60
    let successes = 0
    let conflicts = 0

    for (let i = 0; i < attempts; i += 1) {
      const job = jobs[Math.floor(random() * jobs.length)]
      const agentId = agentIds[Math.floor(random() * agentIds.length)]
      const responder = agentActors[Math.floor(random() * agentActors.length)]
      const op = random()

      let outcome
      if (op < 0.6) {
        // Offer attempt: usually the plausible version 1, sometimes stale.
        const expectedVersion = random() < 0.7 ? 1 : 999
        outcome = await assignJob(dispatcher, job.id, agentId, expectedVersion, {
          key: uniqueKey(`prop-${i}`),
        }).then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        )
        if (outcome.ok) {
          successes += 1
          expect(outcome.value.job.status).toBe('ASSIGNED')
        } else {
          conflicts += 1
          expect(['version_conflict', 'already_assigned', 'agent_not_eligible']).toContain(
            outcome.error.code,
          )
        }
      } else if (op < 0.8) {
        // Accept attempt on the fresh version (or a stale one): exercises the
        // own-offer-first path and the lost-race 409.
        const fresh = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
        const expectedVersion = random() < 0.7 ? fresh.version : 999
        outcome = await acceptJob(responder, job.id, {
          version: expectedVersion,
          key: uniqueKey(`prop-accept-${i}`),
        }).then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        )
        if (outcome.ok) {
          successes += 1
          expect(outcome.value.job.status).toBe('ACCEPTED')
        } else {
          conflicts += 1
          expect(
            ['version_conflict', 'invalid_transition', 'already_assigned', 'forbidden'],
          ).toContain(outcome.error.code)
        }
      } else {
        // Decline attempt on the fresh version (or a stale one).
        const fresh = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
        const expectedVersion = random() < 0.7 ? fresh.version : 999
        outcome = await declineJob(responder, job.id, {
          version: expectedVersion,
          key: uniqueKey(`prop-decline-${i}`),
        }).then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        )
        if (outcome.ok) {
          successes += 1
          expect(outcome.value.job.status).toBe('PENDING')
        } else {
          conflicts += 1
          expect(
            ['version_conflict', 'invalid_transition', 'already_assigned', 'forbidden'],
          ).toContain(outcome.error.code)
        }
      }

      // Invariant sweep after every attempt: no impossible pair anywhere.
      const allJobs = await ownerDatabase.job.findMany({
        where: { organizationId: dispatcher.organizationId },
      })
      for (const row of allJobs) {
        assertPossiblePair(row)
      }
      // At most one active assignment per job, agreeing with the job assignee.
      for (const row of allJobs) {
        const actives = await ownerDatabase.assignment.findMany({
          where: { jobId: row.id, state: { in: ['OFFERED', 'ACCEPTED'] } },
        })
        expect(actives.length).toBeLessThanOrEqual(1)
        if (row.status === 'ASSIGNED' || row.status === 'ACCEPTED') {
          expect(actives).toHaveLength(1)
          expect(row.currentAssigneeId).toBe(actives[0].agentId)
        }
        if (row.status === 'PENDING') {
          expect(actives).toHaveLength(0)
        }
      }
      // Agent cap never exceeded.
      for (const id of agentIds) {
        const count = await activeAssignmentCountForAgent(dispatcher.organizationId, id)
        expect(count).toBeLessThanOrEqual(3)
      }
    }

    // The generator exercised both paths, never an impossible pair.
    expect(successes).toBeGreaterThan(0)
    expect(conflicts).toBeGreaterThan(0)
  })
})
