import { prisma } from '../db/client.js'
import {
  agentNotEligible,
  alreadyAssigned,
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
