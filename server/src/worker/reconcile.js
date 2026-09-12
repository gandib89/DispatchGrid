import { QUEUE_NAMES, enqueueJobEvent, getQueue } from '../lib/queue/index.js'
import { logger } from '../lib/logger.js'

// Reconciliation sweep (B11-T4, DG-2 "reconcile" choice). Finds committed
// work missing its expected async consequence and re-enqueues it through the
// T1 producer — never rolling back committed state. Runs on demand (operator,
// startup, or a later B13/B19 schedule): it takes an owner Prisma client like
// the T2 handler router's `deps.prisma`, never imports services, and never
// enqueues inside a transaction.
//
// ponytail: O(n) queue scan per run (BullMQ range read + in-memory version map);
// switch to deterministic BullMQ jobIds + getJob when volume matters.
// Threshold vocabulary lands in B12 with the Escalation table.
const QUEUE_SCAN_TYPES = ['waiting', 'active', 'delayed', 'paused', 'completed', 'failed']
const QUEUE_SCAN_CAP = 1000

export async function reconcileJobEvents({ prisma, limit = 100, log = logger } = {}) {
  if (!prisma) {
    throw new Error('reconcileJobEvents requires a prisma client')
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('reconcileJobEvents limit must be a positive integer')
  }

  const queued = await getQueue(QUEUE_NAMES.jobEvents).getJobs(QUEUE_SCAN_TYPES, 0, QUEUE_SCAN_CAP)
  const queuedVersions = new Map()
  for (const entry of queued) {
    const { jobId, jobVersion } = entry?.data ?? {}
    if (!jobId || !Number.isInteger(jobVersion)) continue
    queuedVersions.set(jobId, Math.max(queuedVersions.get(jobId) ?? -1, jobVersion))
  }

  let checked = 0
  let cursor
  const requeuedJobIds = []
  for (;;) {
    const jobs = await prisma.job.findMany({
      orderBy: { id: 'asc' },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, organizationId: true, version: true },
    })
    if (jobs.length === 0) break

    checked += jobs.length
    const missing = jobs.filter(
      (candidate) => (queuedVersions.get(candidate.id) ?? -1) < candidate.version,
    )
    for (const job of missing) {
      await enqueueJobEvent({
        type: 'job-event',
        jobId: job.id,
        jobVersion: job.version,
        organizationId: job.organizationId,
        requestId: `reconcile-${job.id}-v${job.version}`,
      })
      queuedVersions.set(job.id, job.version)
      requeuedJobIds.push(job.id)
    }

    cursor = jobs.at(-1).id
    if (jobs.length < limit) break
  }

  const result = { checked, requeued: requeuedJobIds.length, requeuedJobIds }
  log.info(result, 'Reconciliation sweep complete')
  return result
}
