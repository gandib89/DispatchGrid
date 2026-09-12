// Post-commit integration seam (B10-T4, wired B11-T2). Routes call
// afterJobCommit AFTER the service promise resolves (commit done) and after
// cache invalidation. Never import this from services or transactions —
// nothing may enqueue, publish, or invalidate inside a transaction.
import { prisma } from '../db/client.js'
import { logger } from './logger.js'
import {
  enqueueJobEvent,
  enqueueNotification,
  removePendingSlaEvaluations,
  scheduleSlaCheck,
  slaDelayMs,
} from './queue/index.js'

export const integrationAdapters = {
  // Realtime fan-out lands in B15.
  async publishJobEvent(_payload) {},
  async enqueueJobWork(payload) {
    await enqueueJobEvent({
      type: 'job-event',
      jobId: payload.jobId,
      jobVersion: payload.jobVersion,
      organizationId: payload.organizationId,
      requestId: payload.requestId,
    })
  },
  // Breach fan-out (B12): the worker's production path resolves breach side
  // effects through this named seam, backed by the existing realtime publish
  // and job-events queue above — never by ad-hoc fallbacks at the call site.
  async publishEscalationEvent(payload) {
    await integrationAdapters.publishJobEvent({
      jobId: payload.jobId,
      organizationId: payload.organizationId,
      escalationId: payload.escalationId,
      threshold: payload.threshold,
      requestId: payload.requestId,
    })
  },
  // Escalation delivery (B13): a committed escalation becomes one retryable
  // delivery request for the agent holding the job (or its creator while
  // unassigned), typed by threshold. After-commit-only — plain reads, no
  // transaction. A vanished row needs no delivery.
  async enqueueEscalationNotification(payload) {
    const job = await prisma.job.findFirst({
      where: { id: payload.jobId, organizationId: payload.organizationId },
      select: { id: true, currentAssigneeId: true, createdById: true },
    })
    if (!job) {
      logger.info(
        { jobId: payload.jobId, organizationId: payload.organizationId, requestId: payload.requestId },
        'Escalation job vanished before notification enqueue; skipping delivery',
      )
      return
    }
    await enqueueNotification({
      type: 'notification',
      jobId: job.id,
      organizationId: payload.organizationId,
      requestId: payload.requestId,
      notificationType: payload.threshold === 'WARNING' ? 'SLA_WARNING' : 'SLA_BREACH',
      recipientId: job.currentAssigneeId ?? job.createdById,
      ...(payload.escalationId ? { escalationId: payload.escalationId } : {}),
    })
  },
}

export async function afterJobCommit(payload) {
  await integrationAdapters.publishJobEvent(payload)
  await integrationAdapters.enqueueJobWork(payload)
}

// Arm a job's clock after an assignment commit (B12-T3): schedule WARNING and
// BREACH evaluations at DG-4 delays. After-commit-only — plain reads, no
// transaction. The payload freezes the promising policy's id, thresholds, and
// the job's dueAt (A-6: later policy edits never shift enqueued work; the
// handler re-reads state, so only newly assigned jobs see new thresholds).
// The promise source is the organization's earliest-created policy until a
// job-to-policy association lands; an org with no policy promises nothing and
// arms nothing. Throws on failure so the route seam can warn and meter it.
export async function scheduleSlaAfterAssign({ job, organizationId, requestId }) {
  const policy = await prisma.slaPolicy.findFirst({
    where: { organizationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  if (!policy) {
    logger.info({ jobId: job.id, organizationId, requestId }, 'No SLA policy; leaving the job clock unarmed')
    return []
  }
  const dueAt = new Date(job.dueAt).toISOString()
  const frozen = {
    type: 'sla-check',
    jobId: job.id,
    organizationId,
    requestId,
    slaPolicyId: policy.id,
    warningMinutesBefore: policy.warningMinutesBefore,
    breachMinutesAfter: policy.breachMinutesAfter,
    dueAt,
  }
  // A re-assign IS a new assignment (A-6): drop the stale pair first so the
  // fresh promise wins instead of collapsing onto it via deterministic IDs.
  await removePendingSlaEvaluations(job.id)
  return Promise.all(
    ['WARNING', 'BREACH'].map((threshold) =>
      scheduleSlaCheck(
        { ...frozen, threshold },
        { delay: slaDelayMs({ dueAt, threshold, warningMinutesBefore: frozen.warningMinutesBefore, breachMinutesAfter: frozen.breachMinutesAfter }) },
      ),
    ),
  )
}
