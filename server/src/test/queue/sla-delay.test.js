import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { QueueEvents, createNodeRedisClient } from 'bullmq'
import { createClient } from 'redis'
import { seedDatabase } from '../../../prisma/seed.js'
import { app } from '../../app.js'
import { signAccessToken } from '../../auth/tokens.js'
import { env } from '../../env.js'
import { scheduleSlaAfterAssign } from '../../lib/integration-adapters.js'
import {
  QUEUE_NAMES,
  closeQueues,
  getQueue,
  removePendingSlaEvaluations,
  scheduleSlaCheck,
  slaCheckJobId,
  slaDelayMs,
} from '../../lib/queue/index.js'
import { clearBoardCache } from '../../routes/jobs.js'
import { startWorker, stopWorker } from '../../worker.js'
import {
  createOrganizationFixture,
  createOwnerTestClient,
  createRoleFixture,
  createUserFixture,
  resetDatabase,
} from '../helpers.js'

// Queue seam (B11) plus assign-time arming (B12-T3): scheduleSlaCheck enqueues
// threshold evaluations with deterministic identities at DG-4 delays, the
// worker consumes them after the delay, terminal transitions disarm them, and
// policy edits never shift already-scheduled payloads (A-6). Real Redis.
const ownerDatabase = createOwnerTestClient()

const WARNING_BEFORE_MIN = 45
const BREACH_AFTER_MIN = 10

function slaPayload(job, organization, threshold, overrides = {}) {
  return {
    type: 'sla-check',
    jobId: job.id,
    organizationId: organization.id,
    requestId: `req-sla-${crypto.randomUUID()}`,
    threshold,
    slaPolicyId: crypto.randomUUID(),
    warningMinutesBefore: WARNING_BEFORE_MIN,
    breachMinutesAfter: BREACH_AFTER_MIN,
    dueAt: job.dueAt instanceof Date ? job.dueAt.toISOString() : job.dueAt,
    ...overrides,
  }
}

async function delayedForJob(jobId) {
  const delayed = await getQueue(QUEUE_NAMES.sla).getDelayed()
  return delayed.filter((entry) => entry?.data?.jobId === jobId)
}

async function createJobRow(organization, user, dueAt) {
  return ownerDatabase.job.create({
    data: {
      organizationId: organization.id,
      reference: `JOB-${crypto.randomUUID().slice(0, 8)}`,
      title: 'SLA delay fixture',
      latitude: 51.5,
      longitude: -0.12,
      createdById: user.id,
      dueAt,
    },
  })
}

async function createPolicyRow(organization, overrides = {}) {
  return ownerDatabase.slaPolicy.create({
    data: {
      organizationId: organization.id,
      name: `Standard-${crypto.randomUUID().slice(0, 8)}`,
      warningMinutesBefore: WARNING_BEFORE_MIN,
      breachMinutesAfter: BREACH_AFTER_MIN,
      ...overrides,
    },
  })
}

beforeEach(async () => {
  clearBoardCache()
  await resetDatabase(ownerDatabase)
  for (const name of Object.values(QUEUE_NAMES)) {
    await getQueue(name).obliterate({ force: true })
  }
})

afterAll(async () => {
  await stopWorker().catch(() => {})
  await closeQueues()
  await ownerDatabase.$disconnect().catch(() => {})
})

describe('delayed sla-check seam', () => {
  it('enqueues with delay and the worker consumes it after the delay', async () => {
    const organization = await createOrganizationFixture(ownerDatabase)
    const user = await createUserFixture(ownerDatabase)
    const job = await createJobRow(organization, user, new Date(Date.now() + 3_600_000))
    const payload = slaPayload(job, organization, 'WARNING')

    await startWorker({ prisma: ownerDatabase })
    const raw = createClient({ url: env.REDIS_URL })
    const queueEvents = new QueueEvents(QUEUE_NAMES.sla, {
      connection: createNodeRedisClient(raw),
    })
    await queueEvents.waitUntilReady()
    try {
      const enqueued = await scheduleSlaCheck(payload, { delay: 1000 })

      // Enqueued under its deterministic identity with the intended delay.
      expect(enqueued.id).toBe(slaCheckJobId(job.id, 'WARNING'))
      expect(enqueued.opts?.delay).toBe(1000)
      expect(enqueued.data).toMatchObject({ threshold: 'WARNING', jobId: job.id })
      const delayed = await getQueue(QUEUE_NAMES.sla).getDelayed()
      expect(delayed.map((entry) => entry.id)).toContain(enqueued.id)

      // The worker consumes it after the delay: time alone moves the SLA
      // state with zero HTTP requests after scheduling.
      const stored = await getQueue(QUEUE_NAMES.sla).getJob(enqueued.id)
      const returnvalue = await stored.waitUntilFinished(queueEvents, 15_000)
      expect(returnvalue).toMatchObject({
        status: 'sla-escalated',
        jobId: job.id,
        requestId: payload.requestId,
        threshold: 'WARNING',
        slaState: 'WARNING',
      })
      const reloaded = await ownerDatabase.job.findUniqueOrThrow({ where: { id: job.id } })
      expect(reloaded.slaState).toBe('WARNING')
      await expect(
        ownerDatabase.escalation.count({ where: { jobId: job.id, threshold: 'WARNING' } }),
      ).resolves.toBe(1)
      const finished = await getQueue(QUEUE_NAMES.sla).getJob(enqueued.id)
      expect(finished.finishedOn - finished.timestamp).toBeGreaterThanOrEqual(800)
    } finally {
      await queueEvents.close().catch(() => {})
      if (raw?.isOpen) await raw.quit().catch(() => {})
      await stopWorker().catch(() => {})
    }
  })
})

describe('DG-4 delay math', () => {
  const now = 1_700_000_000_000
  const dueAt = new Date(now + 3_600_000).toISOString()

  it('warns before dueAt and breaches after dueAt', () => {
    expect(
      slaDelayMs({ dueAt, threshold: 'WARNING', warningMinutesBefore: 30, breachMinutesAfter: 15, now }),
    ).toBe(1_800_000)
    expect(
      slaDelayMs({ dueAt, threshold: 'BREACH', warningMinutesBefore: 30, breachMinutesAfter: 15, now }),
    ).toBe(4_500_000)
  })

  it('fires exactly at dueAt when both offsets are zero', () => {
    for (const threshold of ['WARNING', 'BREACH']) {
      expect(
        slaDelayMs({ dueAt, threshold, warningMinutesBefore: 0, breachMinutesAfter: 0, now }),
      ).toBe(3_600_000)
    }
  })

  it('schedules immediately when the fire time already passed', () => {
    const pastDueAt = new Date(now - 3_600_000).toISOString()
    expect(
      slaDelayMs({ dueAt: pastDueAt, threshold: 'WARNING', warningMinutesBefore: 30, breachMinutesAfter: 15, now }),
    ).toBe(0)
    expect(
      slaDelayMs({ dueAt: pastDueAt, threshold: 'BREACH', warningMinutesBefore: 30, breachMinutesAfter: 15, now }),
    ).toBe(0)
  })
})

describe('deterministic scheduling identities', () => {
  it('re-scheduling the same threshold collapses to one pending evaluation', async () => {
    const organization = await createOrganizationFixture(ownerDatabase)
    const user = await createUserFixture(ownerDatabase)
    const job = await createJobRow(organization, user, new Date(Date.now() + 3_600_000))

    const first = await scheduleSlaCheck(slaPayload(job, organization, 'WARNING'), { delay: 60_000 })
    const second = await scheduleSlaCheck(
      slaPayload(job, organization, 'WARNING', { warningMinutesBefore: 5, breachMinutesAfter: 5 }),
      { delay: 60_000 },
    )

    expect(second.id).toBe(first.id)
    expect(first.id).toBe(slaCheckJobId(job.id, 'WARNING'))
    const delayed = await delayedForJob(job.id)
    expect(delayed).toHaveLength(1)
    // First promise stands: re-scheduling never shifts the pending payload.
    expect(delayed[0].data).toMatchObject({ warningMinutesBefore: WARNING_BEFORE_MIN })
  })

  it('warning and breach are distinct pending evaluations', async () => {
    const organization = await createOrganizationFixture(ownerDatabase)
    const user = await createUserFixture(ownerDatabase)
    const job = await createJobRow(organization, user, new Date(Date.now() + 3_600_000))

    const warning = await scheduleSlaCheck(slaPayload(job, organization, 'WARNING'), { delay: 60_000 })
    const breach = await scheduleSlaCheck(slaPayload(job, organization, 'BREACH'), { delay: 120_000 })

    expect(warning.id).not.toBe(breach.id)
    expect(await delayedForJob(job.id)).toHaveLength(2)
  })

  it('a settled evaluation never reports armed: re-scheduling re-arms fresh', async () => {
    const organization = await createOrganizationFixture(ownerDatabase)
    const user = await createUserFixture(ownerDatabase)
    const job = await createJobRow(organization, user, new Date(Date.now() + 3_600_000))

    await startWorker({ prisma: ownerDatabase })
    const raw = createClient({ url: env.REDIS_URL })
    const queueEvents = new QueueEvents(QUEUE_NAMES.sla, {
      connection: createNodeRedisClient(raw),
    })
    await queueEvents.waitUntilReady()
    try {
      const first = await scheduleSlaCheck(slaPayload(job, organization, 'WARNING'), { delay: 500 })
      const stored = await getQueue(QUEUE_NAMES.sla).getJob(first.id)
      await stored.waitUntilFinished(queueEvents, 15_000)
      expect(await (await getQueue(QUEUE_NAMES.sla).getJob(first.id)).getState()).toBe('completed')

      // Collapsing onto the completed entry would report armed with nothing
      // pending; instead the settled entry is dropped and a fresh delayed
      // evaluation takes its deterministic identity.
      const second = await scheduleSlaCheck(slaPayload(job, organization, 'WARNING'), { delay: 60_000 })
      expect(second.id).toBe(slaCheckJobId(job.id, 'WARNING'))
      expect(await second.getState()).toBe('delayed')
      expect(await delayedForJob(job.id)).toHaveLength(1)
    } finally {
      await queueEvents.close().catch(() => {})
      if (raw?.isOpen) await raw.quit().catch(() => {})
      await stopWorker().catch(() => {})
    }
  })
})

describe('disarm on terminal', () => {
  it('removes both pending evaluations; a repeat removal is a harmless false', async () => {
    const organization = await createOrganizationFixture(ownerDatabase)
    const user = await createUserFixture(ownerDatabase)
    const job = await createJobRow(organization, user, new Date(Date.now() + 3_600_000))
    await scheduleSlaCheck(slaPayload(job, organization, 'WARNING'), { delay: 60_000 })
    await scheduleSlaCheck(slaPayload(job, organization, 'BREACH'), { delay: 120_000 })

    await expect(removePendingSlaEvaluations(job.id)).resolves.toEqual([true, true])
    expect(await delayedForJob(job.id)).toHaveLength(0)
    await expect(removePendingSlaEvaluations(job.id)).resolves.toEqual([false, false])
  })
})

describe('policy-edit isolation (A-6)', () => {
  it('freezes thresholds at assign time; edits reach only newly armed jobs', async () => {
    const organization = await createOrganizationFixture(ownerDatabase)
    const user = await createUserFixture(ownerDatabase)
    const policy = await createPolicyRow(organization)
    const first = await createJobRow(organization, user, new Date(Date.now() + 7_200_000))

    await scheduleSlaAfterAssign({
      job: first,
      organizationId: organization.id,
      requestId: `req-assign-${crypto.randomUUID()}`,
    })
    const armed = await delayedForJob(first.id)
    expect(armed).toHaveLength(2)
    for (const entry of armed) {
      expect(entry.data).toMatchObject({
        slaPolicyId: policy.id,
        warningMinutesBefore: WARNING_BEFORE_MIN,
        breachMinutesAfter: BREACH_AFTER_MIN,
        dueAt: first.dueAt.toISOString(),
      })
    }

    await ownerDatabase.slaPolicy.update({
      where: { id: policy.id },
      data: { warningMinutesBefore: 5, breachMinutesAfter: 5 },
    })

    // Already-scheduled evaluations keep their original thresholds.
    const kept = await delayedForJob(first.id)
    expect(kept).toHaveLength(2)
    for (const entry of kept) {
      expect(entry.data).toMatchObject({
        warningMinutesBefore: WARNING_BEFORE_MIN,
        breachMinutesAfter: BREACH_AFTER_MIN,
      })
    }

    // Newly armed jobs see the edited policy.
    const second = await createJobRow(organization, user, new Date(Date.now() + 7_200_000))
    await scheduleSlaAfterAssign({
      job: second,
      organizationId: organization.id,
      requestId: `req-assign-${crypto.randomUUID()}`,
    })
    const rearmed = await delayedForJob(second.id)
    expect(rearmed).toHaveLength(2)
    for (const entry of rearmed) {
      expect(entry.data).toMatchObject({ warningMinutesBefore: 5, breachMinutesAfter: 5 })
    }
  })

  it('arms nothing when the organization has no policy', async () => {
    const organization = await createOrganizationFixture(ownerDatabase)
    const user = await createUserFixture(ownerDatabase)
    const job = await createJobRow(organization, user, new Date(Date.now() + 7_200_000))

    await expect(
      scheduleSlaAfterAssign({ job, organizationId: organization.id, requestId: `req-${crypto.randomUUID()}` }),
    ).resolves.toEqual([])
    expect(await delayedForJob(job.id)).toHaveLength(0)
  })

  it('re-assign drops the stale pair and re-arms from the current policy', async () => {
    const organization = await createOrganizationFixture(ownerDatabase)
    const user = await createUserFixture(ownerDatabase)
    const policy = await createPolicyRow(organization)
    const job = await createJobRow(organization, user, new Date(Date.now() + 7_200_000))

    await scheduleSlaAfterAssign({
      job,
      organizationId: organization.id,
      requestId: `req-assign-${crypto.randomUUID()}`,
    })
    expect(await delayedForJob(job.id)).toHaveLength(2)

    await ownerDatabase.slaPolicy.update({
      where: { id: policy.id },
      data: { warningMinutesBefore: 5, breachMinutesAfter: 5 },
    })

    // A re-assign IS a new assignment: the stale promise is dropped first, so
    // the fresh thresholds win instead of collapsing onto the old payload.
    await scheduleSlaAfterAssign({
      job,
      organizationId: organization.id,
      requestId: `req-reassign-${crypto.randomUUID()}`,
    })
    const rearmed = await delayedForJob(job.id)
    expect(rearmed).toHaveLength(2)
    for (const entry of rearmed) {
      expect(entry.data).toMatchObject({
        slaPolicyId: policy.id,
        warningMinutesBefore: 5,
        breachMinutesAfter: 5,
      })
    }
  })

  it('earliest-created policy wins until a job-policy association exists', async () => {
    const organization = await createOrganizationFixture(ownerDatabase)
    const user = await createUserFixture(ownerDatabase)
    const first = await createPolicyRow(organization, { createdAt: new Date(Date.now() - 60_000) })
    await createPolicyRow(organization, { warningMinutesBefore: 5, breachMinutesAfter: 5 })
    const job = await createJobRow(organization, user, new Date(Date.now() + 7_200_000))

    await scheduleSlaAfterAssign({
      job,
      organizationId: organization.id,
      requestId: `req-assign-${crypto.randomUUID()}`,
    })

    const armed = await delayedForJob(job.id)
    expect(armed).toHaveLength(2)
    for (const entry of armed) {
      expect(entry.data).toMatchObject({
        slaPolicyId: first.id,
        warningMinutesBefore: WARNING_BEFORE_MIN,
        breachMinutesAfter: BREACH_AFTER_MIN,
      })
    }
  })
})

describe('assign-path hookup over HTTP', () => {
  beforeEach(async () => {
    await seedDatabase(ownerDatabase)
  })

  async function setupSlaOrg() {
    const organization = await createOrganizationFixture(ownerDatabase)
    await ownerDatabase.counter.create({
      data: { organizationId: organization.id, name: 'job-reference' },
    })
    const dispatcherRole = await createRoleFixture(ownerDatabase, organization.id, {
      name: `DISPATCHER_${crypto.randomUUID().slice(0, 8)}`,
    })
    const agentRole = await createRoleFixture(ownerDatabase, organization.id, { name: 'AGENT' })
    const permissions = await ownerDatabase.permission.findMany({
      where: { code: { in: ['job.view', 'job.create', 'job.assign', 'job.cancel', 'job.respond'] } },
    })
    const permissionId = new Map(permissions.map((entry) => [entry.code, entry.id]))
    for (const code of ['job.view', 'job.create', 'job.assign', 'job.cancel']) {
      await ownerDatabase.rolePermission.create({
        data: { organizationId: organization.id, roleId: dispatcherRole.id, permissionId: permissionId.get(code) },
      })
    }
    for (const code of ['job.view', 'job.respond']) {
      await ownerDatabase.rolePermission.create({
        data: { organizationId: organization.id, roleId: agentRole.id, permissionId: permissionId.get(code) },
      })
    }
    const dispatcher = await createUserFixture(ownerDatabase)
    await ownerDatabase.membership.create({
      data: { organizationId: organization.id, userId: dispatcher.id, roleId: dispatcherRole.id, isAvailable: false },
    })
    const agent = await createUserFixture(ownerDatabase)
    await ownerDatabase.membership.create({
      data: { organizationId: organization.id, userId: agent.id, roleId: agentRole.id, isAvailable: true },
    })
    return {
      organization,
      agent,
      dispatcherToken: signAccessToken(dispatcher.id),
      agentToken: signAccessToken(agent.id),
    }
  }

  function jobPayload() {
    return {
      title: 'Fix basement pump',
      latitude: 51.5,
      longitude: -0.12,
      dueAt: new Date(Date.now() + 7_200_000).toISOString(),
    }
  }

  async function createJob(token) {
    const response = await request(app)
      .post('/api/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send(jobPayload())
    expect(response.status).toBe(201)
    return response.body.job
  }

  it('assign arms both evaluations at DG-4 delays; complete disarms them', async () => {
    const { organization, agent, dispatcherToken, agentToken } = await setupSlaOrg()
    const policy = await createPolicyRow(organization)
    const created = await createJob(dispatcherToken)

    const assigned = await request(app)
      .post(`/api/v1/jobs/${created.id}/assign`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: agent.id, version: created.version })
    expect(assigned.status).toBe(200)
    const jobId = assigned.body.job.id
    const dueMs = new Date(assigned.body.job.dueAt).getTime()

    const armed = await delayedForJob(jobId)
    expect(armed).toHaveLength(2)
    const byThreshold = new Map(armed.map((entry) => [entry.data.threshold, entry]))
    expect([...byThreshold.keys()].sort()).toEqual(['BREACH', 'WARNING'])
    for (const [threshold, entry] of byThreshold) {
      expect(entry.id).toBe(slaCheckJobId(jobId, threshold))
      expect(entry.data).toMatchObject({
        slaPolicyId: policy.id,
        warningMinutesBefore: WARNING_BEFORE_MIN,
        breachMinutesAfter: BREACH_AFTER_MIN,
      })
    }
    const expectedWarning = dueMs - WARNING_BEFORE_MIN * 60_000 - Date.now()
    const expectedBreach = dueMs + BREACH_AFTER_MIN * 60_000 - Date.now()
    expect(Math.abs(byThreshold.get('WARNING').opts.delay - expectedWarning)).toBeLessThan(60_000)
    expect(Math.abs(byThreshold.get('BREACH').opts.delay - expectedBreach)).toBeLessThan(60_000)

    // Walk to COMPLETED through the owned transitions, then the clock disarms.
    let version = assigned.body.job.version
    for (const path of ['accept', 'start', 'complete']) {
      const response = await request(app)
        .post(`/api/v1/jobs/${jobId}/${path}`)
        .set('Authorization', `Bearer ${agentToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ version })
      expect(response.status).toBe(200)
      version = response.body.job.version
    }
    expect(await delayedForJob(jobId)).toHaveLength(0)
  })

  it('cancel disarms the armed evaluations', async () => {
    const { organization, agent, dispatcherToken } = await setupSlaOrg()
    await createPolicyRow(organization)
    const created = await createJob(dispatcherToken)

    const assigned = await request(app)
      .post(`/api/v1/jobs/${created.id}/assign`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: agent.id, version: created.version })
    expect(assigned.status).toBe(200)
    const jobId = assigned.body.job.id
    expect(await delayedForJob(jobId)).toHaveLength(2)

    const cancelled = await request(app)
      .post(`/api/v1/jobs/${jobId}/cancel`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ version: assigned.body.job.version, reason: 'No longer needed' })
    expect(cancelled.status).toBe(200)
    expect(await delayedForJob(jobId)).toHaveLength(0)
  })

  it('decline back to PENDING disarms the armed evaluations', async () => {
    const { organization, agent, dispatcherToken, agentToken } = await setupSlaOrg()
    await createPolicyRow(organization)
    const created = await createJob(dispatcherToken)

    const assigned = await request(app)
      .post(`/api/v1/jobs/${created.id}/assign`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: agent.id, version: created.version })
    expect(assigned.status).toBe(200)
    const jobId = assigned.body.job.id
    expect(await delayedForJob(jobId)).toHaveLength(2)

    // Decline returns the job to PENDING: the stale pair must not survive to
    // escalate a job that no longer carries the assignment it was armed for.
    const declined = await request(app)
      .post(`/api/v1/jobs/${jobId}/decline`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ version: assigned.body.job.version })
    expect(declined.status).toBe(200)
    expect(declined.body.job.status).toBe('PENDING')
    expect(await delayedForJob(jobId)).toHaveLength(0)
  })

  it('fail disarms the armed evaluations', async () => {
    const { organization, agent, dispatcherToken, agentToken } = await setupSlaOrg()
    await createPolicyRow(organization)
    const created = await createJob(dispatcherToken)

    const assigned = await request(app)
      .post(`/api/v1/jobs/${created.id}/assign`)
      .set('Authorization', `Bearer ${dispatcherToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ agentId: agent.id, version: created.version })
    expect(assigned.status).toBe(200)
    const jobId = assigned.body.job.id
    expect(await delayedForJob(jobId)).toHaveLength(2)

    // Walk to IN_PROGRESS through the owned transitions, then fail.
    let version = assigned.body.job.version
    for (const path of ['accept', 'start']) {
      const response = await request(app)
        .post(`/api/v1/jobs/${jobId}/${path}`)
        .set('Authorization', `Bearer ${agentToken}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ version })
      expect(response.status).toBe(200)
      version = response.body.job.version
    }
    const failed = await request(app)
      .post(`/api/v1/jobs/${jobId}/fail`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ version, reason: 'Truck broke down' })
    expect(failed.status).toBe(200)
    expect(failed.body.job.status).toBe('FAILED')
    expect(await delayedForJob(jobId)).toHaveLength(0)
  })
})
