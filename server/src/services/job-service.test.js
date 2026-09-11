import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { seedDatabase } from '../../prisma/seed.js'
import { prisma } from '../db/client.js'
import {
  createOwnerTestClient,
  resetDatabase,
} from '../test/helpers.js'
import {
  cancelJob,
  completeJob,
  createJob,
  failJob,
  patchJob,
  startJob,
} from './job-service.js'

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
    description: 'Standing water near unit 3',
    address: '1 Main St',
    latitude: 51.5,
    longitude: -0.12,
    priority: 'HIGH',
    dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  }
}

function refNumber(reference) {
  return Number(reference.split('-')[2])
}

async function acceptedFixture(actor, agentId) {
  const job = await ownerDatabase.job.create({
    data: {
      organizationId: actor.organizationId,
      reference: 'JOB-2026-000101',
      title: 'Pump repair',
      latitude: 51.5,
      longitude: -0.12,
      status: 'ACCEPTED',
      currentAssigneeId: agentId,
      createdById: actor.userId,
      version: 1,
      dueAt: new Date(Date.now() + 3_600_000),
    },
  })
  await ownerDatabase.assignment.create({
    data: {
      organizationId: actor.organizationId,
      jobId: job.id,
      agentId,
      state: 'ACCEPTED',
    },
  })
  return job
}

async function inProgressFixture(actor, agentId) {
  const job = await acceptedFixture(actor, agentId)
  return ownerDatabase.job.update({
    where: { id: job.id },
    data: { status: 'IN_PROGRESS', version: 2 },
  })
}

describe('createJob', () => {
  it('creates a pending job with a gapless reference and an initial event', async () => {
    const actor = await buildActor(dispatcherEmail)
    const { job, replay } = await createJob(actor, createInput(), { key: 'create-1' })

    expect(replay).toBe(false)
    expect(job.status).toBe('PENDING')
    expect(job.reference).toMatch(/^JOB-\d{4}-\d{6}$/)
    expect(job.version).toBe(1)
    expect(job.organizationId).toBe(actor.organizationId)

    const events = await ownerDatabase.jobEvent.findMany({ where: { jobId: job.id } })
    expect(events).toHaveLength(1)
    expect(events[0].toStatus).toBe('PENDING')
  })

  it('hands consecutive references to concurrent creates', async () => {
    const actor = await buildActor(dispatcherEmail)
    const [first, second] = await Promise.all([
      createJob(actor, createInput({ title: 'Job A' }), { key: 'race-a' }),
      createJob(actor, createInput({ title: 'Job B' }), { key: 'race-b' }),
    ])

    const numbers = [refNumber(first.job.reference), refNumber(second.job.reference)].sort(
      (a, b) => a - b,
    )
    expect(numbers[1] - numbers[0]).toBe(1)
  })

  it('replays the identical response for the same key and body', async () => {
    const actor = await buildActor(dispatcherEmail)
    const input = createInput()
    const first = await createJob(actor, input, { key: 'retry-1' })
    const second = await createJob(actor, { ...input }, { key: 'retry-1' })

    expect(second.replay).toBe(true)
    expect(second.job).toEqual(first.job)
    expect(await ownerDatabase.job.count()).toBe(1)
  })

  it('rejects the same key with a different body', async () => {
    const actor = await buildActor(dispatcherEmail)
    await createJob(actor, createInput(), { key: 'reuse-1' })

    const error = await createJob(actor, createInput({ title: 'Different' }), {
      key: 'reuse-1',
    }).catch((e) => e)
    expect(error.code).toBe('idempotency_key_reuse')
    expect(await ownerDatabase.job.count()).toBe(1)
  })

  it('returns 409 while the same key is still in flight', async () => {
    const actor = await buildActor(dispatcherEmail)
    await ownerDatabase.idempotencyKey.create({
      data: {
        organizationId: actor.organizationId,
        operation: 'job.create',
        key: 'in-flight-1',
        requestFingerprint: 'someone-else-running',
        status: 'IN_PROGRESS',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })

    const error = await createJob(actor, createInput(), { key: 'in-flight-1' }).catch((e) => e)
    expect(error.code).toBe('idempotency_in_progress')
  })

  it('denies creation without the create permission', async () => {
    const agent = await buildActor(agentEmail)
    const error = await createJob(agent, createInput(), { key: 'no-perm-1' }).catch((e) => e)
    expect(error.code).toBe('forbidden')
    expect(await ownerDatabase.job.count()).toBe(0)
  })

  it('rejects out-of-range coordinates before the database has to', async () => {
    const actor = await buildActor(dispatcherEmail)
    await expect(createJob(actor, createInput({ latitude: 91 }), { key: 'bad-lat' })).rejects.toThrow()
  })
})

describe('counter rollback', () => {
  it('consumes no reference number when the transaction rolls back', async () => {
    const { nextCounterValue } = await import('../lib/sequence.js')
    const actor = await buildActor(dispatcherEmail)

    const first = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${actor.organizationId}::text, TRUE)`
      return nextCounterValue(tx, actor.organizationId, 'job-reference')
    })

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.organization_id', ${actor.organizationId}::text, TRUE)`
        await nextCounterValue(tx, actor.organizationId, 'job-reference')
        throw new Error('simulated crash after Counter lock')
      }),
    ).rejects.toThrow('simulated crash')

    const after = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${actor.organizationId}::text, TRUE)`
      return nextCounterValue(tx, actor.organizationId, 'job-reference')
    })

    expect(Number(after - first)).toBe(1)
  })
})

describe('patchJob', () => {
  it('applies mutable fields and increments the version', async () => {
    const actor = await buildActor(dispatcherEmail)
    const { job } = await createJob(actor, createInput(), { key: 'patch-base' })

    const updated = await patchJob(actor, job.id, {
      version: 1,
      title: 'Fix pump urgently',
      priority: 'URGENT',
    })

    expect(updated.job.title).toBe('Fix pump urgently')
    expect(updated.job.version).toBe(2)
  })

  it('conflicts on a stale version with current state attached', async () => {
    const actor = await buildActor(dispatcherEmail)
    const { job } = await createJob(actor, createInput(), { key: 'patch-stale' })
    await patchJob(actor, job.id, { version: 1, title: 'First edit' })

    const error = await patchJob(actor, job.id, { version: 1, title: 'Second edit' }).catch(
      (e) => e,
    )
    expect(error.code).toBe('version_conflict')
  })

  it('returns 404 for another organization’s job', async () => {
    const actor = await buildActor(dispatcherEmail)
    const shadow = await buildActor(shadowEmail)
    const { job } = await createJob(actor, createInput(), { key: 'patch-xorg' })

    const error = await patchJob(shadow, job.id, { version: 1, title: 'Intruder' }).catch(
      (e) => e,
    )
    expect(error.code).toBe('not_found')
  })
})

describe('startJob and completeJob', () => {
  it('starts an accepted job for its owner and writes the event atomically', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await acceptedFixture(dispatcher, agent.userId)

    const { job: started } = await startJob(agent, job.id, { version: 1 })
    expect(started.status).toBe('IN_PROGRESS')
    expect(started.version).toBe(2)

    const events = await ownerDatabase.jobEvent.findMany({
      where: { jobId: job.id },
      orderBy: { createdAt: 'asc' },
    })
    expect(events.map((e) => e.toStatus)).toContain('IN_PROGRESS')
  })

  it('denies start to a non-assigned agent', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const shadow = await buildActor(shadowEmail)
    const job = await acceptedFixture(dispatcher, agent.userId)

    const error = await startJob(
      { ...shadow, organizationId: dispatcher.organizationId },
      job.id,
      { version: 1 },
    ).catch((e) => e)
    expect(error.code).toBe('forbidden')
  })

  it('rejects start from the wrong state', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const { job } = await createJob(dispatcher, createInput(), { key: 'start-wrong' })

    const error = await startJob(agent, job.id, { version: 1 }).catch((e) => e)
    expect(error.code).toBe('invalid_transition')
  })

  it('completes an in-progress job for its owner and closes the assignment', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await inProgressFixture(dispatcher, agent.userId)

    const { job: done } = await completeJob(agent, job.id, { version: 2 })
    expect(done.status).toBe('COMPLETED')
    expect(done.completedAt).not.toBeNull()

    const assignments = await ownerDatabase.assignment.findMany({ where: { jobId: job.id } })
    expect(assignments.every((a) => a.state !== 'OFFERED' && a.state !== 'ACCEPTED')).toBe(true)
  })

  it('rejects completion skipped ahead from accepted', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await acceptedFixture(dispatcher, agent.userId)

    const error = await completeJob(agent, job.id, { version: 1 }).catch((e) => e)
    expect(error.code).toBe('invalid_transition')
  })

  it('replays completion when the success response was lost', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await inProgressFixture(dispatcher, agent.userId)

    const first = await completeJob(agent, job.id, { version: 2, key: 'lost-response' })
    expect(first.replay).toBe(false)
    const second = await completeJob(agent, job.id, { version: 2, key: 'lost-response' })
    expect(second.replay).toBe(true)
    expect(second.job).toEqual(first.job)

    const events = await ownerDatabase.jobEvent.findMany({
      where: { jobId: job.id, toStatus: 'COMPLETED' },
    })
    expect(events).toHaveLength(1)
  })
})

describe('cancelJob and failJob', () => {
  it('cancels a pending job with a reason', async () => {
    const actor = await buildActor(dispatcherEmail)
    const { job } = await createJob(actor, createInput(), { key: 'cancel-1' })

    const { job: cancelled } = await cancelJob(actor, job.id, {
      version: 1,
      reason: 'Duplicate request',
    })
    expect(cancelled.status).toBe('CANCELLED')
  })

  it('rejects cancel of a completed job and cancel without the permission', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const inProgress = await inProgressFixture(dispatcher, agent.userId)
    const { job: done } = await completeJob(agent, inProgress.id, { version: 2 })

    const terminal = await cancelJob(dispatcher, done.id, { version: 3, reason: 'Too late' }).catch(
      (e) => e,
    )
    expect(terminal.code).toBe('invalid_transition')

    const { job: fresh } = await createJob(dispatcher, createInput(), { key: 'cancel-perm' })
    const noperm = await cancelJob(agent, fresh.id, { version: 1, reason: 'Nope' }).catch((e) => e)
    expect(noperm.code).toBe('forbidden')
  })

  it('fails an in-progress job for its owner with a reason', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await inProgressFixture(dispatcher, agent.userId)

    const { job: failed } = await failJob(agent, job.id, {
      version: 2,
      reason: 'Pump seized beyond repair',
    })
    expect(failed.status).toBe('FAILED')
  })

  it('requires a reason and the in-progress state for fail', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await inProgressFixture(dispatcher, agent.userId)

    const noReason = await failJob(agent, job.id, { version: 2, reason: '' }).catch((e) => e)
    expect(['validation_error', 'invalid_transition']).toContain(noReason.code)

    const { job: pending } = await createJob(dispatcher, createInput(), { key: 'fail-state' })
    const wrongState = await failJob(agent, pending.id, { version: 1, reason: 'Nope' }).catch(
      (e) => e,
    )
    expect(wrongState.code).toBe('invalid_transition')
  })
})

describe('transition ownership hardening (B09-T5)', () => {
  it('denies start to a non-assigned agent without touching job, assignment, or timeline', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const shadow = await buildActor(shadowEmail)
    const job = await acceptedFixture(dispatcher, agent.userId)
    const outsider = { ...shadow, organizationId: dispatcher.organizationId }

    const error = await startJob(outsider, job.id, { version: 1 }).catch((e) => e)
    expect(error.code).toBe('forbidden')
    expect(error.status).toBe(403)

    const fresh = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(fresh.status).toBe('ACCEPTED')
    expect(fresh.version).toBe(1)
    expect(fresh.currentAssigneeId).toBe(agent.userId)
    expect(await ownerDatabase.assignment.count({ where: { jobId: job.id } })).toBe(1)
    expect(await ownerDatabase.jobEvent.count({ where: { jobId: job.id } })).toBe(0)
  })

  it('denies complete to a non-assigned agent with respond permission, leaving rows untouched', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const shadow = await buildActor(shadowEmail)
    expect(shadow.permissions).toContain('job.respond')
    const job = await inProgressFixture(dispatcher, agent.userId)
    const outsider = { ...shadow, organizationId: dispatcher.organizationId }

    const error = await completeJob(outsider, job.id, { version: 2 }).catch((e) => e)
    expect(error.code).toBe('forbidden')
    expect(error.status).toBe(403)

    const fresh = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(fresh.status).toBe('IN_PROGRESS')
    expect(fresh.version).toBe(2)
    expect(fresh.currentAssigneeId).toBe(agent.userId)
    expect(fresh.completedAt).toBeNull()
    const assignments = await ownerDatabase.assignment.findMany({ where: { jobId: job.id } })
    expect(assignments).toHaveLength(1)
    expect(assignments[0].state).toBe('ACCEPTED')
    expect(await ownerDatabase.jobEvent.count({ where: { jobId: job.id } })).toBe(0)
  })

  it('denies fail to a non-assigned agent with respond permission, leaving rows untouched', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const shadow = await buildActor(shadowEmail)
    expect(shadow.permissions).toContain('job.respond')
    const job = await inProgressFixture(dispatcher, agent.userId)
    const outsider = { ...shadow, organizationId: dispatcher.organizationId }

    const error = await failJob(outsider, job.id, {
      version: 2,
      reason: 'Not my job but trying anyway',
    }).catch((e) => e)
    expect(error.code).toBe('forbidden')
    expect(error.status).toBe(403)

    const fresh = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(fresh.status).toBe('IN_PROGRESS')
    expect(fresh.version).toBe(2)
    expect(fresh.currentAssigneeId).toBe(agent.userId)
    const assignments = await ownerDatabase.assignment.findMany({ where: { jobId: job.id } })
    expect(assignments).toHaveLength(1)
    expect(assignments[0].state).toBe('ACCEPTED')
    expect(await ownerDatabase.jobEvent.count({ where: { jobId: job.id } })).toBe(0)
  })

  it("lets a dispatcher with cancel permission cancel someone else's job", async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    expect(dispatcher.permissions).toContain('job.cancel')
    const job = await inProgressFixture(dispatcher, agent.userId)

    const { job: cancelled } = await cancelJob(dispatcher, job.id, {
      version: 2,
      reason: 'Customer withdrew the request',
    })
    expect(cancelled.status).toBe('CANCELLED')
    expect(cancelled.version).toBe(3)
    expect(cancelled.currentAssigneeId).toBeNull()

    const assignments = await ownerDatabase.assignment.findMany({ where: { jobId: job.id } })
    expect(assignments).toHaveLength(1)
    expect(assignments[0].state).toBe('REVOKED')
    const events = await ownerDatabase.jobEvent.findMany({ where: { jobId: job.id } })
    expect(events).toHaveLength(1)
    expect(events[0].toStatus).toBe('CANCELLED')
  })

  it('denies start to the assignee without the respond permission', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await acceptedFixture(dispatcher, agent.userId)
    const withoutRespond = {
      ...agent,
      permissions: agent.permissions.filter((code) => code !== 'job.respond'),
    }

    const error = await startJob(withoutRespond, job.id, { version: 1 }).catch((e) => e)
    expect(error.code).toBe('forbidden')
    expect(error.status).toBe(403)

    const fresh = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(fresh.status).toBe('ACCEPTED')
    expect(fresh.version).toBe(1)
    expect(await ownerDatabase.jobEvent.count({ where: { jobId: job.id } })).toBe(0)
  })

  it('denies complete to the assignee without the respond permission', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await inProgressFixture(dispatcher, agent.userId)
    const withoutRespond = {
      ...agent,
      permissions: agent.permissions.filter((code) => code !== 'job.respond'),
    }

    const error = await completeJob(withoutRespond, job.id, { version: 2 }).catch((e) => e)
    expect(error.code).toBe('forbidden')
    expect(error.status).toBe(403)

    const fresh = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(fresh.status).toBe('IN_PROGRESS')
    expect(fresh.version).toBe(2)
    expect(fresh.completedAt).toBeNull()
    expect(await ownerDatabase.jobEvent.count({ where: { jobId: job.id } })).toBe(0)
  })

  it('denies fail to the assignee without the respond permission', async () => {
    const dispatcher = await buildActor(dispatcherEmail)
    const agent = await buildActor(agentEmail)
    const job = await inProgressFixture(dispatcher, agent.userId)
    const withoutRespond = {
      ...agent,
      permissions: agent.permissions.filter((code) => code !== 'job.respond'),
    }

    const error = await failJob(withoutRespond, job.id, {
      version: 2,
      reason: 'Pump seized beyond repair',
    }).catch((e) => e)
    expect(error.code).toBe('forbidden')
    expect(error.status).toBe(403)

    const fresh = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(fresh.status).toBe('IN_PROGRESS')
    expect(fresh.version).toBe(2)
    expect(await ownerDatabase.jobEvent.count({ where: { jobId: job.id } })).toBe(0)
  })
})
