import { prisma } from '../db/client.js'
import { forbidden, notFound, versionConflict } from '../errors/http-errors.js'
import { completeKey, dropKey, fingerprintRequest, reserveKey } from '../lib/idempotency.js'

// Shared service-layer plumbing. Every service is transaction-aware with the
// signature (actor, input, options) where options carries an optional outer
// transaction handle and idempotency key. Nothing here touches HTTP, queues,
// sockets, or caches, so worker reuse stays intact.

export function requireActor(actor) {
  if (!actor?.userId || !actor?.organizationId) {
    throw forbidden('Invalid actor')
  }
}

export function requirePermission(actor, code) {
  requireActor(actor)
  if (!actor.permissions?.includes(code)) {
    throw forbidden('This action is not allowed')
  }
}

export function toPlain(row) {
  return JSON.parse(JSON.stringify(row))
}

export async function setOrgContext(tx, organizationId) {
  await tx.$executeRaw`SELECT set_config('app.organization_id', ${organizationId}::text, TRUE)`
}

export async function scopedJob(tx, actor, jobId) {
  const job = await tx.job.findFirst({
    where: { id: jobId, organizationId: actor.organizationId },
  })
  if (!job) {
    throw notFound('Job not found')
  }
  return job
}

// Shared zero-row-claim fallback: every version-claim loser re-reads the job
// inside the same transaction and reports 404 when the row vanished or 409
// version_conflict with current state when it moved. One helper so the four
// assignment operations cannot drift apart.
export async function claimConflict(tx, actor, jobId) {
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

// Idempotent wrapper shared by every mutating operation. Without a key the
// work runs once in a single transaction. With a key, three short transactions
// reserve the key, execute the work, and store the replayable response, so a
// lost response or a retry never executes the business write twice.
export async function runIdempotent({
  operation,
  organizationId,
  key,
  fingerprintSource,
  responseStatus,
  execute,
}) {
  if (!key) {
    const data = await prisma.$transaction((tx) => execute(tx))
    return { data, replay: false }
  }

  const fingerprint = fingerprintRequest(fingerprintSource)
  const reservation = await prisma.$transaction((tx) =>
    reserveKey(tx, { organizationId, operation, key, fingerprint }),
  )
  if (reservation.outcome === 'replay') {
    return { data: reservation.record.responseBody, replay: true }
  }

  let data
  try {
    data = await prisma.$transaction((tx) => execute(tx))
  } catch (error) {
    await prisma.$transaction((tx) => dropKey(tx, reservation.record.id)).catch(() => {})
    throw error
  }

  const body = toPlain(data)
  await prisma.$transaction((tx) => completeKey(tx, reservation.record.id, responseStatus, body))
  return { data: body, replay: false }
}
