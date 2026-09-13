import { prisma } from '../../db/client.js'

// B14-T5 (#42): bounded ping history. Standalone lib op, deliberately no
// route or scheduler call site: retention is an operator/cron concern, and
// the hot ping path stays lean. Invoke from a cron/worker with an
// organizationId per tenant (or omit it for a whole-database sweep).
// Deletes only LocationPing rows with recordedAt strictly older than 30
// days — the boundary row is kept (lt, never lte) — and never touches
// jobs, events, assignments, escalations, or anything else (single-model
// deleteMany; proven by the route-seam prune test).
export const PING_RETENTION_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

export async function pruneExpiredPings(options = {}) {
  const { organizationId, now = new Date(), db = prisma } = options
  const cutoff = new Date(now.getTime() - PING_RETENTION_DAYS * DAY_MS)
  const where = { recordedAt: { lt: cutoff } }
  if (organizationId !== undefined) {
    where.organizationId = organizationId
  }
  const { count } = await db.locationPing.deleteMany({ where })
  return { deleted: count, cutoff }
}
