// Post-commit integration seam (B10-T4, wired B11-T2). Routes call
// afterJobCommit AFTER the service promise resolves (commit done) and after
// cache invalidation. Never import this from services or transactions —
// nothing may enqueue, publish, or invalidate inside a transaction.
import { prisma } from '../db/client.js'
import { logger } from './logger.js'
import { enqueueJobEvent, scheduleSlaCheck, slaDelayMs } from './queue/index.js'

export const integrationAdapters = {
  // Realtime fan-out lands in B15.
  async publishJobEvent(_payload) {},
  async enqueueJobWork(payload) {
    await enqueueJobEvent({
      type: 'job-event',
      jobId: payload.jobId,
      organizationId: payload.organizationId,
      requestId: payload.requestId,
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
  return Promise.all(
    ['WARNING', 'BREACH'].map((threshold) =>
      scheduleSlaCheck(
        { ...frozen, threshold },
        { delay: slaDelayMs({ dueAt, threshold, warningMinutesBefore: frozen.warningMinutesBefore, breachMinutesAfter: frozen.breachMinutesAfter }) },
      ),
    ),
  )
}
