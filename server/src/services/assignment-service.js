import { prisma } from '../db/client.js'
import {
  agentNotEligible,
  alreadyAssigned,
  forbidden,
  invalidTransition,
  notFound,
  versionConflict,
} from '../errors/http-errors.js'
import { checkAgentEligibility } from '../lib/jobs/eligibility.js'
import {
  requirePermission,
  runIdempotent,
  scopedJob,
  toPlain,
} from './transaction.js'

const ACTIVE_ASSIGNMENT_STATES = ['OFFERED', 'ACCEPTED']

// Lock order for every operation touching both membership and job rows:
// membership first, then the job claim. Job-only operations never take the
// membership lock, so no path locks in the opposite order. Documented here so
// later assignment operations keep the same discipline at ReadCommitted.
async function lockMembership(tx, actor, agentUserId) {
  const rows = await tx.$queryRaw`
    SELECT id FROM "Membership"
    WHERE "userId" = ${agentUserId}::uuid AND "organizationId" = ${actor.organizationId}::uuid
    FOR UPDATE
  `
  return rows.length > 0
}

async function activeAssignmentCount(tx, actor, agentUserId) {
  return tx.assignment.count({
    where: {
      organizationId: actor.organizationId,
      agentId: agentUserId,
      state: { in: ACTIVE_ASSIGNMENT_STATES },
    },
  })
}

function isUniqueViolation(error) {
  return error?.code === 'P2002'
}

export async function assignJob(actor, jobId, agentUserId, expectedVersion, options = {}) {
  requirePermission(actor, 'job.assign')

  const membership = await scopedMembership(actor, agentUserId)

  const { data, replay } = await runIdempotent({
    operation: 'job.assign',
    organizationId: actor.organizationId,
    key: options.key,
    fingerprintSource: { jobId, agentUserId, expectedVersion },
    responseStatus: 200,
    execute: async (tx) => {
      const locked = await lockMembership(tx, actor, agentUserId)
      if (!locked) {
        throw agentNotEligible('This agent cannot take this job', {
          reasons: ['unknown_membership'],
        })
      }

      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: actor.organizationId },
      })
      const activeJobCount = await activeAssignmentCount(tx, actor, agentUserId)
      const eligibility = checkAgentEligibility({
        membership,
        organizationId: actor.organizationId,
        activeJobCount,
        defaultCap: organization.defaultConcurrentJobCap,
      })
      if (!eligibility.eligible) {
        throw agentNotEligible('This agent cannot take this job', {
          reasons: eligibility.reasons,
        })
      }

      const job = await scopedJob(tx, actor, jobId)
      if (job.status !== 'PENDING') {
        throw invalidTransition(`Only pending jobs can be offered, not ${job.status}`)
      }

      const claimed = await tx.job.updateMany({
        where: { id: jobId, organizationId: actor.organizationId, version: expectedVersion, status: 'PENDING' },
        data: { status: 'ASSIGNED', version: job.version + 1, currentAssigneeId: agentUserId },
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

      let assignment
      try {
        assignment = await tx.assignment.create({
          data: {
            organizationId: actor.organizationId,
            jobId,
            agentId: agentUserId,
            state: 'OFFERED',
          },
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw alreadyAssigned('This job already has an active assignment')
        }
        throw error
      }

      await tx.jobEvent.create({
        data: {
          organizationId: actor.organizationId,
          jobId,
          actorUserId: actor.userId,
          fromStatus: 'PENDING',
          toStatus: 'ASSIGNED',
          reason: 'Agent offered',
        },
      })

      const updated = await tx.job.findUniqueOrThrow({ where: { id: jobId } })
      return { job: toPlain(updated), assignment: toPlain(assignment) }
    },
  })

  return { ...data, replay }
}

async function scopedMembership(actor, agentUserId) {
  const membership = await prisma.membership.findFirst({
    where: { userId: agentUserId, organizationId: actor.organizationId },
    include: { role: true },
  })
  if (!membership) {
    throw agentNotEligible('This agent cannot take this job', {
      reasons: ['wrong_organization'],
    })
  }
  return membership
}

// Rejection-code choice (documented): a missing or non-OFFERED assignment is
// 422 invalid_transition, never 409. The 409 version_conflict is reserved for
// a stale expectedVersion on an otherwise valid owned offer, so callers can
// tell "someone else changed the job, re-read and retry" apart from "there is
// no offer for you to answer". Ownership violations are 403 forbidden and are
// checked before the version claim so a cross-agent probe never learns
// version state.
export async function acceptJob(actor, jobId, input = {}) {
  requirePermission(actor, 'job.respond')
  const expectedVersion = input?.version

  const { data, replay } = await runIdempotent({
    operation: 'job.accept',
    organizationId: actor.organizationId,
    key: input?.key,
    fingerprintSource: { jobId, version: expectedVersion },
    responseStatus: 200,
    execute: async (tx) => {
      const job = await scopedJob(tx, actor, jobId)

      const offer = await tx.assignment.findFirst({
        where: {
          organizationId: actor.organizationId,
          jobId,
          state: 'OFFERED',
        },
        orderBy: { createdAt: 'desc' },
      })
      if (!offer) {
        throw invalidTransition(`Only offered jobs can be accepted, not ${job.status}`)
      }
      if (offer.agentId !== actor.userId) {
        throw forbidden('Only the offered agent can accept this job')
      }
      if (job.status !== 'ASSIGNED') {
        throw invalidTransition(`Only assigned jobs can be accepted, not ${job.status}`)
      }

      const claimed = await tx.job.updateMany({
        where: {
          id: jobId,
          organizationId: actor.organizationId,
          version: expectedVersion,
          status: 'ASSIGNED',
        },
        data: { status: 'ACCEPTED', version: job.version + 1 },
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

      const moved = await tx.assignment.updateMany({
        where: {
          id: offer.id,
          organizationId: actor.organizationId,
          state: 'OFFERED',
        },
        data: { state: 'ACCEPTED' },
      })
      if (moved.count === 0) {
        throw invalidTransition('This offer is no longer available')
      }

      await tx.jobEvent.create({
        data: {
          organizationId: actor.organizationId,
          jobId,
          actorUserId: actor.userId,
          fromStatus: 'ASSIGNED',
          toStatus: 'ACCEPTED',
          reason: 'Agent accepted',
        },
      })

      const updated = await tx.job.findUniqueOrThrow({ where: { id: jobId } })
      const accepted = await tx.assignment.findUniqueOrThrow({ where: { id: offer.id } })
      return { job: toPlain(updated), assignment: toPlain(accepted) }
    },
  })

  return { ...data, replay }
}

export async function declineJob(actor, jobId, input = {}) {
  requirePermission(actor, 'job.respond')
  const expectedVersion = input?.version

  const { data, replay } = await runIdempotent({
    operation: 'job.decline',
    organizationId: actor.organizationId,
    key: input?.key,
    fingerprintSource: { jobId, version: expectedVersion },
    responseStatus: 200,
    execute: async (tx) => {
      const job = await scopedJob(tx, actor, jobId)

      const offer = await tx.assignment.findFirst({
        where: {
          organizationId: actor.organizationId,
          jobId,
          state: 'OFFERED',
        },
        orderBy: { createdAt: 'desc' },
      })
      if (!offer) {
        throw invalidTransition(`Only offered jobs can be declined, not ${job.status}`)
      }
      if (offer.agentId !== actor.userId) {
        throw forbidden('Only the offered agent can decline this job')
      }
      if (job.status !== 'ASSIGNED') {
        throw invalidTransition(`Only assigned jobs can be declined, not ${job.status}`)
      }

      const claimed = await tx.job.updateMany({
        where: {
          id: jobId,
          organizationId: actor.organizationId,
          version: expectedVersion,
          status: 'ASSIGNED',
        },
        data: { status: 'PENDING', version: job.version + 1, currentAssigneeId: null },
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

      const moved = await tx.assignment.updateMany({
        where: {
          id: offer.id,
          organizationId: actor.organizationId,
          state: 'OFFERED',
        },
        data: { state: 'DECLINED' },
      })
      if (moved.count === 0) {
        throw invalidTransition('This offer is no longer available')
      }

      await tx.jobEvent.create({
        data: {
          organizationId: actor.organizationId,
          jobId,
          actorUserId: actor.userId,
          fromStatus: 'ASSIGNED',
          toStatus: 'PENDING',
          reason: 'Agent declined',
        },
      })

      const updated = await tx.job.findUniqueOrThrow({ where: { id: jobId } })
      const declined = await tx.assignment.findUniqueOrThrow({ where: { id: offer.id } })
      return { job: toPlain(updated), assignment: toPlain(declined) }
    },
  })

  return { ...data, replay }
}
