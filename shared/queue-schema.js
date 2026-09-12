// Runtime-neutral shared queue contracts. No Express, Prisma, React, or env reads.
// Server and client import the factory with their own zod instance:
//   import { z } from 'zod'
//   import { queueSchemas } from './queue-schema.js'
//   const schemas = queueSchemas(z)
//
// Queue payloads are requests to evaluate work, never durable truth and never
// whole ORM records: every payload carries IDs, the organization ID, a type,
// and the originating request ID so async work traces back to its HTTP cause.

export const QUEUE_MESSAGE_TYPES = Object.freeze(['job-event', 'sla-check', 'notification'])

// Delivery vocabulary for retryable communication (B13): assignment notices,
// generic job updates, completion notices, and SLA threshold notices. Mirrors
// the NotificationType enum so the handler can distinguish urgency from the
// payload, not the queue name.
export const NOTIFICATION_TYPES = Object.freeze([
  'JOB_ASSIGNED',
  'JOB_UPDATED',
  'JOB_COMPLETED',
  'SLA_WARNING',
  'SLA_BREACH',
])

// Threshold vocabulary for delayed evaluation (B12): WARNING fires before the
// deadline, BREACH at/after it. Mirrors the Escalation threshold enum so the
// handler can distinguish urgency from the payload, not the queue name.
export const SLA_THRESHOLDS = Object.freeze(['WARNING', 'BREACH'])

export function queueSchemas(z) {
  const basePayloadSchema = z.object({
    organizationId: z.string().uuid(),
    requestId: z.string().min(1).max(128),
  })

  const jobEventPayloadSchema = basePayloadSchema
    .extend({
      type: z.literal('job-event'),
      jobId: z.string().uuid(),
      jobVersion: z.number().int().nonnegative(),
    })
    .strict()

  // Delayed evaluation request (B12-T3): the threshold travels in the payload
  // alongside a frozen copy of the promise made at assignment time —
  // slaPolicyId names the promising policy while warningMinutesBefore,
  // breachMinutesAfter, and dueAt carry its exact values, so later policy
  // edits (A-6) can never shift already-scheduled evaluations.
  const slaCheckPayloadSchema = basePayloadSchema
    .extend({
      type: z.literal('sla-check'),
      jobId: z.string().uuid(),
      threshold: z.enum(SLA_THRESHOLDS),
      slaPolicyId: z.string().uuid(),
      warningMinutesBefore: z.number().int().min(0),
      breachMinutesAfter: z.number().int().min(0),
      dueAt: z.string().datetime(),
    })
    .strict()

  // Retryable delivery request (B13): the notification type travels in the
  // payload alongside the recipient, so routing stays outside the Jobs and
  // SLA modules. escalationId is optional correlation for threshold notices.
  const notificationPayloadSchema = basePayloadSchema
    .extend({
      type: z.literal('notification'),
      jobId: z.string().uuid(),
      notificationType: z.enum(NOTIFICATION_TYPES),
      recipientId: z.string().uuid(),
      escalationId: z.string().uuid().optional(),
    })
    .strict()

  const queuePayloadSchema = z.discriminatedUnion('type', [
    jobEventPayloadSchema,
    slaCheckPayloadSchema,
    notificationPayloadSchema,
  ])

  return {
    jobEventPayloadSchema,
    slaCheckPayloadSchema,
    notificationPayloadSchema,
    queuePayloadSchema,
  }
}
