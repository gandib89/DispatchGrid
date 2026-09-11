import { prisma } from '../db/client.js'
import { getRequestContext } from '../lib/request-context.js'
import { logger } from '../lib/logger.js'

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function auditLog(req, res, next) {
  res.on('finish', () => {
    if (!MUTATING_METHODS.has(req.method)) return
    if (res.statusCode < 200 || res.statusCode >= 300) return
    if (req.idempotentReplay) return
    if (!req.actor) return

    const entry = req.auditEntry || {
      action: `${req.method} ${req.path}`,
      resourceType: 'organization',
      resourceId: req.params?.orgId || req.actor.organizationId,
    }

    prisma.auditLog
      .create({
        data: {
          organizationId: req.actor.organizationId,
          actorUserId: req.actor.userId,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          requestId: req.id || getRequestContext()?.requestId,
          metadata: entry.metadata,
        },
      })
      .catch((error) => {
        logger.warn({ error }, 'Best-effort audit log write failed')
      })
  })

  next()
}
