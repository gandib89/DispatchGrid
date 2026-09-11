// Runtime-neutral shared contracts. No Express, Prisma, React, or env reads.
// Server and client import the factory with their own zod instance:
//   import { z } from 'zod'
//   import { organizationSchemas } from './organization-schema.js'
//   const schemas = organizationSchemas(z)

export function organizationSchemas(z) {
  const createOrganizationSchema = z
    .object({
      name: z.string().min(1).max(160),
      defaultConcurrentJobCap: z.number().int().min(1).max(50).optional(),
    })
    .strict()

  const updateMemberSchema = z
    .object({
      roleId: z.string().uuid().optional(),
      isAvailable: z.boolean().optional(),
      concurrentJobCap: z.number().int().min(1).max(50).nullable().optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, {
      message: 'At least one field must be provided',
    })

  const organizationIdParamsSchema = z
    .object({
      orgId: z.string().uuid(),
    })
    .strict()

  const memberParamsSchema = z
    .object({
      orgId: z.string().uuid(),
      membershipId: z.string().uuid(),
    })
    .strict()

  return {
    createOrganizationSchema,
    updateMemberSchema,
    organizationIdParamsSchema,
    memberParamsSchema,
  }
}
