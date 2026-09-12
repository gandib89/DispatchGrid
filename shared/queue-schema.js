// Runtime-neutral shared queue contracts. No Express, Prisma, React, or env reads.
// Server and client import the factory with their own zod instance:
//   import { z } from 'zod'
//   import { queueSchemas } from './queue-schema.js'
//   const schemas = queueSchemas(z)
//
// Queue payloads are requests to evaluate work, never durable truth and never
// whole ORM records: every payload carries IDs, the organization ID, a type,
// and the originating request ID so async work traces back to its HTTP cause.

export const QUEUE_MESSAGE_TYPES = Object.freeze(['job-event', 'sla-check'])

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

  const queuePayloadSchema = z.discriminatedUnion('type', [
    jobEventPayloadSchema,
    slaCheckPayloadSchema,
  ])

  return {
    jobEventPayloadSchema,
    slaCheckPayloadSchema,
    queuePayloadSchema,
  }
}
