// Runtime-neutral shared job contracts. No Express, Prisma, React, or env reads.
// Server and client import the factory with their own zod instance:
//   import { z } from 'zod'
//   import { jobSchemas } from './job-schema.js'
//   const schemas = jobSchemas(z)

export const JOB_STATUSES = Object.freeze([
  'PENDING',
  'ASSIGNED',
  'ACCEPTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
])

export const JOB_PRIORITIES = Object.freeze(['LOW', 'NORMAL', 'HIGH', 'URGENT'])

export function jobSchemas(z) {
  const createJobSchema = z
    .object({
      title: z.string().min(1).max(160),
      description: z.string().max(2000).optional(),
      address: z.string().min(1).max(255).optional(),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      priority: z.enum(JOB_PRIORITIES).default('NORMAL'),
      dueAt: z.string().datetime(),
    })
    .strict()

  const jobIdParamsSchema = z
    .object({
      id: z.string().uuid(),
    })
    .strict()

  const jobQuerySchema = z
    .object({
      status: z
        .union([z.enum(JOB_STATUSES), z.array(z.enum(JOB_STATUSES))])
        .optional(),
      priority: z.enum(JOB_PRIORITIES).optional(),
      assigneeId: z.string().uuid().optional(),
      dueBefore: z.string().datetime().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      sort: z.enum(['dueAt', 'priority', 'createdAt']).default('dueAt'),
    })
    .strict()

  const updateJobSchema = z
    .object({
      title: z.string().min(1).max(160).optional(),
      description: z.string().max(2000).nullable().optional(),
      address: z.string().min(1).max(255).optional(),
      priority: z.enum(JOB_PRIORITIES).optional(),
      dueAt: z.string().datetime().optional(),
      version: z.number().int().min(1),
    })
    .strict()
    .refine(
      (value) =>
        value.title !== undefined ||
        value.description !== undefined ||
        value.address !== undefined ||
        value.priority !== undefined ||
        value.dueAt !== undefined,
      { message: 'At least one mutable field must be provided' },
    )

  const assignJobSchema = z
    .object({
      agentId: z.string().uuid(),
      version: z.number().int().min(1),
    })
    .strict()

  const versionOnlySchema = z
    .object({
      version: z.number().int().min(1),
    })
    .strict()

  const completeJobSchema = z
    .object({
      version: z.number().int().min(1),
      proofReference: z.string().min(1).max(255).optional(),
    })
    .strict()

  const cancelJobSchema = z
    .object({
      version: z.number().int().min(1),
      reason: z.string().min(1).max(500),
    })
    .strict()

  const failJobSchema = z
    .object({
      version: z.number().int().min(1),
      reason: z.string().min(1).max(500),
    })
    .strict()

  return {
    createJobSchema,
    jobIdParamsSchema,
    jobQuerySchema,
    updateJobSchema,
    assignJobSchema,
    versionOnlySchema,
    completeJobSchema,
    cancelJobSchema,
    failJobSchema,
  }
}
