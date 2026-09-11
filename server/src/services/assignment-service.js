import { prisma } from '../db/client.js'
import {
  agentNotEligible,
  alreadyAssigned,
  badRequest,
  invalidTransition,
  versionConflict,
} from '../errors/http-errors.js'
import { checkAgentEligibility } from '../lib/jobs/eligibility.js'
import {
  claimConflict,
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
// Returns the freshly locked membership row (with role name) so eligibility
// is always decided on post-lock state, never on a stale outer read.
export async function lockMembership(tx, actor, agentUserId) {
  const rows = await tx.$queryRaw`
    SELECT m.id, m."organizationId", m."userId", m."roleId",
           m."isAvailable", m."concurrentJobCap", r.name AS "roleName"
    FROM "Membership" m
    JOIN "Role" r ON r.id = m."roleId" AND r."organizationId" = m."organizationId"
    WHERE m."userId" = ${agentUserId}::uuid AND m."organizationId" = ${actor.organizationId}::uuid
    FOR UPDATE
  `
  if (rows.length === 0) {
    return null
  }
  const row = rows[0]
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    roleId: row.roleId,
    isAvailable: row.isAvailable,
    concurrentJobCap: row.concurrentJobCap,
    roleName: row.roleName,
    role: { name: row.roleName },
  }
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

  // Outer read keeps the scope check (wrong_organization) before the tx;
  // eligibility itself is decided on the post-lock row inside the tx below.
  await scopedMembership(actor, agentUserId)

  const { data, replay } = await runIdempotent({
    operation: 'job.assign',
    organizationId: actor.organizationId,
    key: options.key,
    fingerprintSource: { jobId, agentUserId, expectedVersion },
    responseStatus: 200,
    execute: async (tx) => {
      const lockedMembership = await lockMembership(tx, actor, agentUserId)
      if (!lockedMembership) {
        throw agentNotEligible('This agent cannot take this job', {
          reasons: ['unknown_membership'],
        })
      }

      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: actor.organizationId },
      })
      const activeJobCount = await activeAssignmentCount(tx, actor, agentUserId)
      const eligibility = checkAgentEligibility({
        membership: lockedMembership,
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
        // Race contract (B09-T2): a loser that reads the job after the winner
        // committed must still receive a 409 with current state, never a 422.
        // The atomic version-plus-status claim below is the correctness guard
        // for the true concurrent window; this fast path only normalizes the
        // already-decided outcome to the same conflict shape.
        throw versionConflict('The job changed since it was read', {
          currentVersion: job.version,
          currentStatus: job.status,
        })
      }

      const claimed = await tx.job.updateMany({
        where: { id: jobId, organizationId: actor.organizationId, version: expectedVersion, status: 'PENDING' },
        data: { status: 'ASSIGNED', version: job.version + 1, currentAssigneeId: agentUserId },
      })
      if (claimed.count === 0) {
        await claimConflict(tx, actor, jobId)
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

// Rejection-code choice (documented): the actor's OWN OFFERED assignment is
// the only answerable offer. No own offer plus another live OFFERED row is a
// lost race -> 409 version_conflict with current state; no OFFERED row at all
// is 422 invalid_transition. The 409 version_conflict is also used for a stale
// expectedVersion on an otherwise valid owned offer, so callers can tell
// "someone else changed the job, re-read and retry" apart from "there is no
// offer for you to answer".
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
          agentId: actor.userId,
          state: 'OFFERED',
        },
        orderBy: { createdAt: 'desc' },
      })
      if (!offer) {
        const rivalOffer = await tx.assignment.findFirst({
          where: {
            organizationId: actor.organizationId,
            jobId,
            state: 'OFFERED',
          },
          orderBy: { createdAt: 'desc' },
        })
        if (rivalOffer) {
          throw versionConflict('The job changed since it was read', {
            currentVersion: job.version,
            currentStatus: job.status,
          })
        }
        throw invalidTransition(`Only offered jobs can be accepted, not ${job.status}`)
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
        await claimConflict(tx, actor, jobId)
      }

      const offerMove = await tx.assignment.updateMany({
        where: {
          id: offer.id,
          organizationId: actor.organizationId,
          state: 'OFFERED',
        },
        data: { state: 'ACCEPTED' },
      })
      if (offerMove.count === 0) {
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
          agentId: actor.userId,
          state: 'OFFERED',
        },
        orderBy: { createdAt: 'desc' },
      })
      if (!offer) {
        const rivalOffer = await tx.assignment.findFirst({
          where: {
            organizationId: actor.organizationId,
            jobId,
            state: 'OFFERED',
          },
          orderBy: { createdAt: 'desc' },
        })
        if (rivalOffer) {
          throw versionConflict('The job changed since it was read', {
            currentVersion: job.version,
            currentStatus: job.status,
          })
        }
        throw invalidTransition(`Only offered jobs can be declined, not ${job.status}`)
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
        await claimConflict(tx, actor, jobId)
      }

      const offerMove = await tx.assignment.updateMany({
        where: {
          id: offer.id,
          organizationId: actor.organizationId,
          state: 'OFFERED',
        },
        data: { state: 'DECLINED' },
      })
      if (offerMove.count === 0) {
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


export async function reassignJob(actor, jobId, newAgentUserId, expectedVersion, reason, options = {}) {
  requirePermission(actor, 'job.assign')

  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw badRequest('A reason is required to reassign a job')
  }

  // Outer read keeps the scope check (wrong_organization) before the tx;
  // eligibility itself is decided on the post-lock row inside the tx below.
  await scopedMembership(actor, newAgentUserId)

  const { data, replay } = await runIdempotent({
    operation: 'job.reassign',
    organizationId: actor.organizationId,
    key: options.key,
    fingerprintSource: { jobId, newAgentUserId, expectedVersion, reason },
    responseStatus: 200,
    execute: async (tx) => {
      const lockedMembership = await lockMembership(tx, actor, newAgentUserId)
      if (!lockedMembership) {
        throw agentNotEligible('This agent cannot take this job', {
          reasons: ['unknown_membership'],
        })
      }

      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: actor.organizationId },
      })
      const activeJobCount = await activeAssignmentCount(tx, actor, newAgentUserId)
      const eligibility = checkAgentEligibility({
        membership: lockedMembership,
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
      if (job.status === 'PENDING') {
        // PENDING was never assigned: wrong operation, the caller should use
        // the offer path. Every other non-ASSIGNED status falls through to
        // the conditional version claim below so a sequential loser learns
        // the current version and status via 409, never a bare 422.
        throw invalidTransition(`Only assigned jobs can be reassigned, not ${job.status}`)
      }

      const claimed = await tx.job.updateMany({
        where: { id: jobId, organizationId: actor.organizationId, version: expectedVersion, status: 'ASSIGNED' },
        data: { status: 'ASSIGNED', version: job.version + 1, currentAssigneeId: newAgentUserId },
      })
      if (claimed.count === 0) {
        await claimConflict(tx, actor, jobId)
      }

      await tx.assignment.updateMany({
        where: {
          organizationId: actor.organizationId,
          jobId,
          state: { in: ACTIVE_ASSIGNMENT_STATES },
        },
        data: { state: 'REVOKED' },
      })

      let assignment
      try {
        assignment = await tx.assignment.create({
          data: {
            organizationId: actor.organizationId,
            jobId,
            agentId: newAgentUserId,
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
          fromStatus: 'ASSIGNED',
          toStatus: 'ASSIGNED',
          reason,
        },
      })

      const updated = await tx.job.findUniqueOrThrow({ where: { id: jobId } })
      return { job: toPlain(updated), assignment: toPlain(assignment) }
    },
  })

  return { ...data, replay }
}

