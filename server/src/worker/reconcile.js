import {
  QUEUE_NAMES,
  enqueueJobEvent,
  enqueueNotification,
  getQueue,
  notificationJobId,
} from '../lib/queue/index.js'
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

// Notification gap sweep (B13, DG-2 "reconcile" choice). Finds committed
// business rows missing their expected async delivery and re-enqueues it
// through the T1 producer — never rolling back committed state. Scope
// mirrors exactly what the production path promises: ASSIGNED jobs get a
// JOB_ASSIGNED delivery for the current assignee, BREACH escalations get an
// SLA_BREACH delivery. WARNING escalations intentionally promise no delivery
// (the breach-only fan-out), so the sweep leaves them alone. Re-enqueues
// collapse onto pending deliveries by deterministic queue id.
//
// ponytail: O(n) per-row SENT lookup per run; add a covering anti-join when
// escalations outgrow page scans.
export async function reconcileNotifications({ prisma, limit = 100, log = logger } = {}) {
  if (!prisma) {
    throw new Error('reconcileNotifications requires a prisma client')
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('reconcileNotifications limit must be a positive integer')
  }

  const requeuedJobIds = []
  let checked = 0

  async function ensureDelivery({ organizationId, job, notificationType, recipientId, escalationId }) {
    const sent = await prisma.notification.findFirst({
      where: { jobId: job.id, type: notificationType, recipientId, status: 'SENT' },
    })
    if (sent) return
    // A SENT record or a still-pending delivery means the gap is already
    // healed or healing: only a missing consequence is repaired.
    const pending = await getQueue(QUEUE_NAMES.notifications)
      .getJob(notificationJobId(job.id, notificationType, recipientId))
      .catch(() => undefined)
    if (pending) {
      const state = await pending.getState().catch(() => undefined)
      if (state === 'delayed' || state === 'waiting' || state === 'active' || state === 'prioritized') {
        return
      }
    }
    await enqueueNotification({
      type: 'notification',
      jobId: job.id,
      organizationId,
      requestId: `reconcile-${job.id}-${notificationType}`,
      notificationType,
      recipientId,
      ...(escalationId ? { escalationId } : {}),
    })
    requeuedJobIds.push(job.id)
  }

  // Committed assignments without their expected delivery.
  let cursor
  for (;;) {
    const jobs = await prisma.job.findMany({
      where: { status: 'ASSIGNED' },
      orderBy: { id: 'asc' },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, organizationId: true, currentAssigneeId: true },
    })
    if (jobs.length === 0) break
    checked += jobs.length
    for (const job of jobs) {
      if (!job.currentAssigneeId) continue
      await ensureDelivery({
        organizationId: job.organizationId,
        job,
        notificationType: 'JOB_ASSIGNED',
        recipientId: job.currentAssigneeId,
      })
    }
    cursor = jobs.at(-1).id
    if (jobs.length < limit) break
  }

  // Committed breach escalations without their expected delivery.
  let escalationCursor
  for (;;) {
    const escalations = await prisma.escalation.findMany({
      where: { threshold: 'BREACH' },
      orderBy: { id: 'asc' },
      take: limit,
      ...(escalationCursor ? { cursor: { id: escalationCursor }, skip: 1 } : {}),
      select: { id: true, jobId: true, organizationId: true },
    })
    if (escalations.length === 0) break
    checked += escalations.length
    for (const escalation of escalations) {
      const job = await prisma.job.findFirst({
        where: { id: escalation.jobId, organizationId: escalation.organizationId },
        select: { id: true, currentAssigneeId: true, createdById: true },
      })
      if (!job) continue
      await ensureDelivery({
        organizationId: escalation.organizationId,
        job,
        notificationType: 'SLA_BREACH',
        recipientId: job.currentAssigneeId ?? job.createdById,
        escalationId: escalation.id,
      })
    }
    escalationCursor = escalations.at(-1).id
    if (escalations.length < limit) break
  }

  const result = { checked, requeued: requeuedJobIds.length, requeuedJobIds }
  log.info(result, 'Notification reconciliation sweep complete')
  return result
}
