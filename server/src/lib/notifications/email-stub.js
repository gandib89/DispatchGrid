import { logger } from '../logger.js'

// Single adapter boundary for external delivery (B13). The baseline stub
// performs no provider call: it logs safe routing fields (IDs + type, never
// message bodies) and resolves. Tests force failures through
// failNextDelivery instead of stubbing the network.
let forcedFailures = 0

export function failNextDelivery(count = 1) {
  forcedFailures += count
}

export function resetDeliveryFailures() {
  forcedFailures = 0
}

export async function sendNotification({ jobId, organizationId, notificationType, recipientId, requestId }) {
  if (forcedFailures > 0) {
    forcedFailures -= 1
    throw new Error(`email-stub forced failure for ${requestId}`)
  }
  logger.info(
    { jobId, organizationId, notificationType, recipientId, requestId },
    'Notification delivered (stub)',
  )
  return { deliveredAt: new Date().toISOString() }
}
