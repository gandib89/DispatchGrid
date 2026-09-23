import { UnrecoverableError } from 'bullmq'
import { z } from 'zod'
import { queueSchemas } from '../../../../shared/queue-schema.js'
import { logger } from '../../lib/logger.js'

const schemas = queueSchemas(z)

// Baseline invite delivery (B16-T3): the local handler stub on the existing
// queue foundation — parse at entry, re-read the durable invitation (payload
// is a request, not truth), and acknowledge with correlation in the logs.
// B13's Notification pipeline can absorb the real send later. Under
// at-least-once delivery, a revoked (deleted) or already-accepted row is a
// safe no-op, never a retry.
export async function handleInviteDelivery(payload, deps = {}) {
  let data
  try {
    data = schemas.inviteDeliveryPayloadSchema.parse(payload)
  } catch (error) {
    throw new UnrecoverableError(`Unprocessable invite-delivery payload: ${error.message}`)
  }

  const log = (deps.log ?? logger).child({
    handler: 'invite-delivery',
    requestId: data.requestId,
    invitationId: data.invitationId,
    organizationId: data.organizationId,
  })

  const invitation = await deps.prisma.invitation.findFirst({
    where: { id: data.invitationId, organizationId: data.organizationId },
  })

  if (!invitation) {
    log.info('Invite delivery for missing invitation; acknowledging as no-op')
    return {
      status: 'invite-missing-noop',
      invitationId: data.invitationId,
      requestId: data.requestId,
    }
  }

  if (invitation.acceptedAt) {
    log.info('Invite delivery for accepted invitation; acknowledging as no-op')
    return {
      status: 'invite-accepted-noop',
      invitationId: invitation.id,
      requestId: data.requestId,
    }
  }

  log.info({ expiresAt: invitation.expiresAt.toISOString() }, 'Invite delivery acknowledged')
  return { status: 'invite-delivery-ack', invitationId: invitation.id, requestId: data.requestId }
}
