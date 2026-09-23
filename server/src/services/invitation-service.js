import crypto from 'node:crypto'
import { prisma } from '../db/client.js'
import { badRequest, conflict, notFound } from '../errors/http-errors.js'
import { requirePermission } from './transaction.js'

// B16-T3 invitation issue/revoke. Shared transaction-aware signature
// (actor, input, options); options.tx joins an outer transaction like the
// other services. Only the SHA-256 hash is stored — the plaintext token
// exists solely in the issue return value, which the route hands to the
// after-commit delivery enqueue and never serializes to a client.

const TOKEN_BYTES = 32
const INVITATION_TTL_MS = 72 * 60 * 60 * 1000

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function runTransactional(options, work) {
  return options.tx ? work(options.tx) : prisma.$transaction(work)
}

export async function issueInvitation(actor, input, options = {}) {
  requirePermission(actor, 'org.invite')

  const email = typeof input?.email === 'string' ? input.email.toLowerCase() : ''
  if (!email) {
    throw badRequest('An email is required')
  }

  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS)

  let invitation
  try {
    invitation = await runTransactional(options, (tx) =>
      tx.invitation.create({
        data: {
          organizationId: actor.organizationId,
          email,
          tokenHash: hashToken(token),
          expiresAt,
        },
      }),
    )
  } catch (error) {
    if (error?.code === 'P2002') {
      // Unique violation: the pending-invite partial index or tokenHash.
      // Re-read outside the aborted transaction to name the conflict.
      const pending = await prisma.invitation.findFirst({
        where: { organizationId: actor.organizationId, email, acceptedAt: null },
      })
      if (pending) {
        throw conflict('A pending invitation for this email already exists')
      }
      throw conflict('Invitation token collision')
    }
    throw error
  }

  return { invitation, token }
}

export async function revokeInvitation(actor, input, options = {}) {
  requirePermission(actor, 'org.invite')

  const invitationId = input?.invitationId
  if (typeof invitationId !== 'string' || invitationId.length === 0) {
    throw badRequest('An invitation id is required')
  }

  return runTransactional(options, async (tx) => {
    const invitation = await tx.invitation.findFirst({
      where: { id: invitationId, organizationId: actor.organizationId },
    })
    if (!invitation) {
      throw notFound('Invitation not found')
    }
    if (invitation.acceptedAt) {
      throw conflict('This invitation has already been accepted')
    }
    await tx.invitation.delete({ where: { id: invitation.id } })
    return { invitation }
  })
}
