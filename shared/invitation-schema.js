// Runtime-neutral shared invitation contracts. No Express, Prisma, React, or env reads.
// Server and client import the factory with their own zod instance:
//   import { z } from 'zod'
//   import { invitationSchemas } from './invitation-schema.js'
//   const schemas = invitationSchemas(z)

export function invitationSchemas(z) {
  const issueInvitationSchema = z
    .object({
      email: z.string().email(),
    })
    .strict()

  const invitationIdParamsSchema = z
    .object({
      orgId: z.string().uuid(),
      invitationId: z.string().uuid(),
    })
    .strict()

  return {
    issueInvitationSchema,
    invitationIdParamsSchema,
  }
}
