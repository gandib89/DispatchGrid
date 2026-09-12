// Runtime-neutral shared SLA policy contracts. No Express, Prisma, React, or env reads.
// Server and client import the factory with their own zod instance:
//   import { z } from 'zod'
//   import { slaSchemas } from './sla-schema.js'
//   const schemas = slaSchemas(z)

export function slaSchemas(z) {
  const createSlaPolicySchema = z
    .object({
      name: z.string().min(1).max(80),
      warningMinutesBefore: z.number().int().min(0),
      breachMinutesAfter: z.number().int().min(0),
    })
    .strict()

  const updateSlaPolicySchema = z
    .object({
      name: z.string().min(1).max(80).optional(),
      warningMinutesBefore: z.number().int().min(0).optional(),
      breachMinutesAfter: z.number().int().min(0).optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.name !== undefined ||
        value.warningMinutesBefore !== undefined ||
        value.breachMinutesAfter !== undefined,
      { message: 'At least one mutable field must be provided' },
    )

  const slaPolicyIdParamsSchema = z
    .object({
      id: z.string().uuid(),
    })
    .strict()

  return {
    createSlaPolicySchema,
    updateSlaPolicySchema,
    slaPolicyIdParamsSchema,
  }
}
