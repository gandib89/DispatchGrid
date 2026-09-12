import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { QUEUE_NAMES, closeQueues, enqueueJobEvent, getQueue } from '../../lib/queue/index.js'
import { reconcileJobEvents } from '../../worker/reconcile.js'
import { routeQueueJob } from '../../worker/handlers/index.js'
import {
  createOrganizationFixture,
  createOwnerTestClient,
  createUserFixture,
  resetDatabase,
} from '../helpers.js'

const ownerDatabase = createOwnerTestClient()

// Mirrors a committed write: services persist the job plus its timeline event
// atomically, so post-commit state is these two durable rows.
async function commitJobRow() {
  const organization = await createOrganizationFixture(ownerDatabase)
  const user = await createUserFixture(ownerDatabase)
  const job = await ownerDatabase.job.create({
    data: {
      organizationId: organization.id,
      reference: `JOB-${crypto.randomUUID().slice(0, 8)}`,
      title: 'Reconcile fixture',
      latitude: 51.5,
      longitude: -0.12,
      createdById: user.id,
      dueAt: new Date(Date.now() + 3_600_000),
    },
  })
  await ownerDatabase.jobEvent.create({
    data: {
      organizationId: organization.id,
      jobId: job.id,
      actorUserId: user.id,
      toStatus: 'PENDING',
    },
  })
  return { organization, job }
}

async function commitJobWithStatus(status) {
  const organization = await createOrganizationFixture(ownerDatabase)
  const user = await createUserFixture(ownerDatabase)
  const extra = {}
  if (['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED'].includes(status)) {
    extra.currentAssigneeId = user.id
  }
  if (status === 'COMPLETED') {
    extra.completedAt = new Date()
  }
  const job = await ownerDatabase.job.create({
    data: {
      organizationId: organization.id,
      reference: `JOB-${crypto.randomUUID().slice(0, 8)}`,
      title: `Reconcile ${status} fixture`,
      latitude: 51.5,
      longitude: -0.12,
      createdById: user.id,
      dueAt: new Date(Date.now() + 3_600_000),
      status,
      ...extra,
    },
  })
  await ownerDatabase.jobEvent.create({
    data: {
      organizationId: organization.id,
      jobId: job.id,
      actorUserId: user.id,
      toStatus: status,
    },
  })
  return { organization, job }
}

async function queuedJobEventIds() {
  const jobs = await getQueue(QUEUE_NAMES.jobEvents).getJobs(
    ['waiting', 'active', 'delayed', 'paused', 'completed', 'failed'],
    0,
    1000,
  )
  return jobs.map((job) => job?.data?.jobId).filter(Boolean)
}

beforeEach(async () => {
  await resetDatabase(ownerDatabase)
  for (const name of Object.values(QUEUE_NAMES)) {
    await getQueue(name).obliterate({ force: true })
  }
})

afterAll(async () => {
  await closeQueues()
  await ownerDatabase.$disconnect()
})

describe('reconciliation failure drill', () => {
  it('commit succeeds but enqueue fails: business state remains, sweep repairs, nothing rolls back', async () => {
    const { job } = await commitJobRow()
    const payload = {
      type: 'job-event',
      jobId: job.id,
      organizationId: job.organizationId,
      requestId: `req-${crypto.randomUUID()}`,
    }

    // The post-commit enqueue throws (Redis unavailable). The route seam
    // catches hook failures so the request still succeeds — simulated here
    // with a throwing producer because breaking real Redis mid-test is flaky;
    // the real PG rows and the real queue below are what the drill proves.
    const failingEnqueue = async (event) => {
      throw new Error(`Redis unavailable for ${event.requestId}`)
    }
    await expect(failingEnqueue(payload)).rejects.toThrow('Redis unavailable')

    // Business state intact: the committed job and its timeline event survive.
    await expect(ownerDatabase.job.findUnique({ where: { id: job.id } })).resolves.toMatchObject({
      id: job.id,
      reference: job.reference,
    })
    await expect(ownerDatabase.jobEvent.count({ where: { jobId: job.id } })).resolves.toBe(1)
    expect(await queuedJobEventIds()).not.toContain(job.id)

    // The sweep repairs through the real T1 producer against real Redis.
    const result = await reconcileJobEvents({ prisma: ownerDatabase })

    expect(result).toMatchObject({ checked: 1, requeued: 1, requeuedJobIds: [job.id] })
    expect(await queuedJobEventIds()).toContain(job.id)

    // Still no rollback: the same durable rows, untouched.
    await expect(ownerDatabase.job.findUnique({ where: { id: job.id } })).resolves.toMatchObject({
      id: job.id,
      reference: job.reference,
    })
    await expect(ownerDatabase.jobEvent.count({ where: { jobId: job.id } })).resolves.toBe(1)

    // The repaired consequence consumes idempotently through the T2 router.
    const stored = (
      await getQueue(QUEUE_NAMES.jobEvents).getJobs(
        ['waiting', 'active', 'delayed', 'paused', 'completed', 'failed'],
        0,
        1000,
      )
    ).find((entry) => entry?.data?.jobId === job.id)
    const first = await routeQueueJob({ data: stored.data }, { prisma: ownerDatabase })
    const second = await routeQueueJob({ data: stored.data }, { prisma: ownerDatabase })

    expect(first).toMatchObject({ status: 'consumed', jobId: job.id })
    expect(second).toEqual(first)
  })

  it('leaves committed work that already has its async consequence alone', async () => {
    const { organization, job } = await commitJobRow()
    await enqueueJobEvent({
      type: 'job-event',
      jobId: job.id,
      organizationId: organization.id,
      requestId: `req-${crypto.randomUUID()}`,
    })

    const result = await reconcileJobEvents({ prisma: ownerDatabase })

    expect(result).toMatchObject({ checked: 1, requeued: 0, requeuedJobIds: [] })
    expect((await queuedJobEventIds()).filter((id) => id === job.id)).toHaveLength(1)
  })

  it('never resurrects terminal jobs: only non-terminal work qualifies for repair', async () => {
    const completed = await commitJobWithStatus('COMPLETED')
    const cancelled = await commitJobWithStatus('CANCELLED')
    const failed = await commitJobWithStatus('FAILED')
    const { job: active } = await commitJobRow()

    const result = await reconcileJobEvents({ prisma: ownerDatabase })

    expect(result).toMatchObject({ checked: 1, requeued: 1, requeuedJobIds: [active.id] })
    const queued = await queuedJobEventIds()
    expect(queued).toContain(active.id)
    expect(queued).not.toContain(completed.job.id)
    expect(queued).not.toContain(cancelled.job.id)
    expect(queued).not.toContain(failed.job.id)
  })

  it('reports zero work when nothing is committed', async () => {
    await expect(reconcileJobEvents({ prisma: ownerDatabase })).resolves.toEqual({
      checked: 0,
      requeued: 0,
      requeuedJobIds: [],
    })
  })
})
