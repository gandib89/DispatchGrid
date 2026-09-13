// Runtime-neutral shared ping contracts. No Express, Prisma, React, or env reads.
// Server and client import the factory with their own zod instance:
//   import { z } from 'zod'
//   import { pingSchemas } from './ping-schema.js'
//   const schemas = pingSchemas(z)

export function pingSchemas(z) {
  // B14-T3 (#40): agent ping ingestion. The agent identity is never in the
  // body — it is derived from the request actor — so a spoofed agentId is an
  // unknown field and rejected. jobId is nullable per A-8 (accepted decision:
  // a ping may exist without a job association).
  const createPingSchema = z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracy: z.number().min(0),
      recordedAt: z.string().datetime(),
      jobId: z.string().uuid().nullish(),
    })
    .strict()

  const pingParamsSchema = z.object({}).strict()

  const pingQuerySchema = z.object({}).strict()

  return {
    createPingSchema,
    pingParamsSchema,
    pingQuerySchema,
  }
}
