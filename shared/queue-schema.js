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

// NOTE (B11): `sla-check` is a generic delayed message type here — queue
// existence is T1's requirement. Threshold vocabulary (warning/breach) and
// deterministic keys land in B12 with the Escalation table.

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

  const slaCheckPayloadSchema = basePayloadSchema
    .extend({
      type: z.literal('sla-check'),
      jobId: z.string().uuid(),
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
