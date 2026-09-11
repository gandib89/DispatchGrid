import { prisma } from '../db/client.js'
import {
  badRequest,
  forbidden,
  invalidTransition,
  notFound,
  versionConflict,
} from '../errors/http-errors.js'
import { assertTransition } from '../lib/jobs/state-machine.js'
import { formatJobReference, nextCounterValue } from '../lib/sequence.js'
import {
  requirePermission,
  runIdempotent,
  scopedJob,
  setOrgContext,
} from './transaction.js'

const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT']
const NON_TERMINAL = ['PENDING', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS']
const ACTIVE_ASSIGNMENT_STATES = ['OFFERED', 'ACCEPTED']
const COUNTER_NAME = 'job-reference'

function canonicalCreateInput(input) {
  const title = input?.title
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > 160) {
    throw badRequest('Title must be 1..160 characters')
  }
  const latitude = input?.latitude
  const longitude = input?.longitude
  if (typeof latitude !== 'number' || latitude < -90 || latitude > 90) {
    throw badRequest('Latitude must be between -90 and 90')
  }
  if (typeof longitude !== 'number' || longitude < -180 || longitude > 180) {
    throw badRequest('Longitude must be between -180 and 180')
  }
  const priority = input?.priority ?? 'NORMAL'
  if (!PRIORITIES.includes(priority)) {
    throw badRequest('Unknown priority')
  }
  const dueAt = new Date(input?.dueAt)
  if (Number.isNaN(dueAt.getTime())) {
    throw badRequest('dueAt must be a valid datetime')
  }
  return {
    title: title.trim(),
    description: input?.description ?? null,
    address: input?.address ?? null,
    latitude,
    longitude,
    priority,
    dueAt: dueAt.toISOString(),
  }
}

export async function createJob(actor, input, options = {}) {
  requirePermission(actor, 'job.create')
  const canonical = canonicalCreateInput(input)

  const { data, replay } = await runIdempotent({
    operation: 'job.create',
    organizationId: actor.organizationId,
    key: options.key,
    fingerprintSource: canonical,
    responseStatus: 201,
    execute: async (tx) => {
      await setOrgContext(tx, actor.organizationId)
      const reference = formatJobReference(
        new Date(),
        await nextCounterValue(tx, actor.organizationId, COUNTER_NAME),
      )
      const job = await tx.job.create({
        data: {
          organizationId: actor.organizationId,
          reference,
          title: canonical.title,
          description: canonical.description,
          address: canonical.address,
          latitude: canonical.latitude,
          longitude: canonical.longitude,
          priority: canonical.priority,
          status: 'PENDING',
          slaState: 'OK',
          currentAssigneeId: null,
          createdById: actor.userId,
          version: 1,
          dueAt: new Date(canonical.dueAt),
        },
      })
      await tx.jobEvent.create({
        data: {
          organizationId: actor.organizationId,
          jobId: job.id,
          actorUserId: actor.userId,
          fromStatus: null,
          toStatus: 'PENDING',
          reason: 'Job created',
        },
      })
      return job
    },
  })

  return { job: data, replay }
}

function requireReason(reason) {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw badRequest('A reason is required')
  }
  return reason.trim()
}

// Core transition runner: capability first (stateless), then everything else
// inside the idempotent execution. The key reservation happens before the
// execution, so a replayed key returns the stored response without
// re-validating state — otherwise a retried success would report a bogus
// transition error instead of replaying.
async function transition({
  actor,
  jobId,
  permission,
  operation,
  key,
  responseStatus,
  toStatus,
  version,
  extraUpdate = {},
  eventReason,
  requireOwner = false,
  closeAssignmentsTo = null,
}) {
  requirePermission(actor, permission)

  const { data, replay } = await runIdempotent({
    operation,
    organizationId: actor.organizationId,
    key,
    // Fingerprint covers client intent only. Server-generated values such as the
    // completion timestamp are excluded: a retry arriving later must replay,
    // not look like a different request.
    fingerprintSource: { jobId, toStatus, version, eventReason },
    responseStatus,
    execute: async (tx) => {
      const current = await scopedJob(tx, actor, jobId)
      try {
        assertTransition(current.status, toStatus)
      } catch {
        throw invalidTransition(`Cannot move job from ${current.status} to ${toStatus}`)
      }
      if (requireOwner && current.currentAssigneeId !== actor.userId) {
        throw forbidden('Only the assigned agent can perform this action')
      }
      const claimed = await tx.job.updateMany({
        where: {
          id: jobId,
          organizationId: actor.organizationId,
          version,
          status: current.status,
        },
        data: { status: toStatus, version: current.version + 1, ...extraUpdate },
      })
      if (claimed.count === 0) {
        const fresh = await tx.job.findFirst({
          where: { id: jobId, organizationId: actor.organizationId },
        })
        if (!fresh) {
          throw notFound('Job not found')
        }
        throw versionConflict('The job changed since it was read', {
          currentVersion: fresh.version,
          currentStatus: fresh.status,
        })
      }
      if (closeAssignmentsTo) {
        await tx.assignment.updateMany({
          where: {
            jobId,
            organizationId: actor.organizationId,
            state: { in: ACTIVE_ASSIGNMENT_STATES },
          },
          data: { state: closeAssignmentsTo },
        })
      }
      await tx.jobEvent.create({
        data: {
          organizationId: actor.organizationId,
          jobId,
          actorUserId: actor.userId,
          fromStatus: current.status,
          toStatus,
          reason: eventReason ?? null,
        },
      })
      return tx.job.findUniqueOrThrow({ where: { id: jobId } })
    },
  })

  return { job: data, replay }
}

export async function patchJob(actor, jobId, input, options = {}) {
  const job = await scopedJob(prisma, actor, jobId)
  requirePermission(actor, 'job.update')
  if (!NON_TERMINAL.includes(job.status)) {
    throw invalidTransition(`Cannot edit a ${job.status} job`)
  }

  const data = {}
  if (input?.title !== undefined) {
    if (typeof input.title !== 'string' || input.title.trim().length === 0 || input.title.length > 160) {
      throw badRequest('Title must be 1..160 characters')
    }
    data.title = input.title.trim()
  }
  if (input?.description !== undefined) {
    data.description = input.description
  }
  if (input?.address !== undefined) {
    data.address = input.address
  }
  if (input?.priority !== undefined) {
    if (!PRIORITIES.includes(input.priority)) {
      throw badRequest('Unknown priority')
    }
    data.priority = input.priority
  }
  if (input?.dueAt !== undefined) {
    const dueAt = new Date(input.dueAt)
    if (Number.isNaN(dueAt.getTime())) {
      throw badRequest('dueAt must be a valid datetime')
    }
    data.dueAt = dueAt
  }
  if (Object.keys(data).length === 0) {
    throw badRequest('At least one mutable field must be provided')
  }
  const { data: updated, replay } = await runIdempotent({
    operation: 'job.patch',
    organizationId: actor.organizationId,
    key: options.key,
    fingerprintSource: { jobId, version: input?.version, data },
    responseStatus: 200,
    execute: async (tx) => {
      const claimed = await tx.job.updateMany({
        where: { id: jobId, organizationId: actor.organizationId, version: input?.version },
        data: { ...data, version: job.version + 1 },
      })
      if (claimed.count === 0) {
        const fresh = await tx.job.findFirst({
          where: { id: jobId, organizationId: actor.organizationId },
        })
        if (!fresh) {
          throw notFound('Job not found')
        }
        throw versionConflict('The job changed since it was read', {
          currentVersion: fresh.version,
          currentStatus: fresh.status,
        })
      }
      await tx.jobEvent.create({
        data: {
          organizationId: actor.organizationId,
          jobId,
          actorUserId: actor.userId,
          fromStatus: job.status,
          toStatus: job.status,
          reason: 'Job updated',
        },
      })
      return tx.job.findUniqueOrThrow({ where: { id: jobId } })
    },
  })

  return { job: updated, replay }
}

export async function startJob(actor, jobId, input = {}, options = {}) {
  return transition({
    actor,
    jobId,
    permission: 'job.respond',
    operation: 'job.start',
    key: input.key ?? options.key,
    responseStatus: 200,
    toStatus: 'IN_PROGRESS',
    version: input.version,
    eventReason: 'Work started',
    requireOwner: true,
  })
}

export async function completeJob(actor, jobId, input = {}, options = {}) {
  return transition({
    actor,
    jobId,
    permission: 'job.respond',
    operation: 'job.complete',
    key: input.key ?? options.key,
    responseStatus: 200,
    toStatus: 'COMPLETED',
    version: input.version,
    extraUpdate: { completedAt: new Date() },
    eventReason: input.reason ?? 'Work completed',
    requireOwner: true,
    closeAssignmentsTo: 'COMPLETED',
  })
}

export async function cancelJob(actor, jobId, input = {}, options = {}) {
  const reason = requireReason(input.reason)
  return transition({
    actor,
    jobId,
    permission: 'job.cancel',
    operation: 'job.cancel',
    key: input.key ?? options.key,
    responseStatus: 200,
    toStatus: 'CANCELLED',
    version: input.version,
    eventReason: reason,
    closeAssignmentsTo: 'REVOKED',
  })
}

export async function failJob(actor, jobId, input = {}, options = {}) {
  const reason = requireReason(input.reason)
  return transition({
    actor,
    jobId,
    permission: 'job.respond',
    operation: 'job.fail',
    key: input.key ?? options.key,
    responseStatus: 200,
    toStatus: 'FAILED',
    version: input.version,
    eventReason: reason,
    requireOwner: true,
    closeAssignmentsTo: 'REVOKED',
  })
}
