import { QUEUE_NAMES, enqueueJobEvent, getQueue } from '../lib/queue/index.js'
import { logger } from '../lib/logger.js'

// Reconciliation sweep (B11-T4, DG-2 "reconcile" choice). Finds committed
// work missing its expected async consequence and re-enqueues it through the
// T1 producer — never rolling back committed state. Runs on demand (operator,
// startup, or a later B13/B19 schedule): it takes an owner Prisma client like
// the T2 handler router's `deps.prisma`, never imports services, and never
// enqueues inside a transaction.
//
// ponytail: O(n) queue scan per run (BullMQ range read + in-memory jobId set);
// switch to deterministic BullMQ jobIds + getJob when volume matters
// (B12 already sets the precedent with sla:{jobId}:{thresholdType} keys).
const QUEUE_SCAN_TYPES = ['waiting', 'active', 'delayed', 'paused', 'completed', 'failed']
const QUEUE_SCAN_CAP = 1000

export async function reconcileJobEvents({ prisma, limit = 100, log = logger } = {}) {
  if (!prisma) {
    throw new Error('reconcileJobEvents requires a prisma client')
  }

  const jobs = await prisma.job.findMany({
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: { id: true, organizationId: true },
  })

  if (jobs.length === 0) {
    return { checked: 0, requeued: 0, requeuedJobIds: [] }
  }

  const queued = await getQueue(QUEUE_NAMES.jobEvents).getJobs(QUEUE_SCAN_TYPES, 0, QUEUE_SCAN_CAP)
  const seen = new Set(queued.map((job) => job?.data?.jobId).filter(Boolean))

  const requeuedJobIds = []
  for (const job of jobs.filter((candidate) => !seen.has(candidate.id))) {
    await enqueueJobEvent({
      type: 'job-event',
      jobId: job.id,
      organizationId: job.organizationId,
      requestId: `reconcile-${job.id}`,
    })
    requeuedJobIds.push(job.id)
  }

  const result = { checked: jobs.length, requeued: requeuedJobIds.length, requeuedJobIds }
  log.info(result, 'Reconciliation sweep complete')
  return result
}
