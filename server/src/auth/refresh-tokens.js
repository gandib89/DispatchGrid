import { randomUUID } from 'node:crypto'
import { prisma } from '../db/client.js'
import { generateRefreshToken, hashRefreshToken } from './tokens.js'

export async function issueRefreshToken(userId, familyId = randomUUID(), tx = prisma) {
  const { raw, tokenHash, expiresAt } = generateRefreshToken()
  const created = await tx.refreshToken.create({
    data: { userId, familyId, tokenHash, expiresAt },
  })
  return { raw, familyId, tokenId: created.id }
}

export async function rotateRefreshToken(rawToken, tx = prisma) {
  const tokenHash = hashRefreshToken(rawToken)
  const stored = await tx.refreshToken.findUnique({ where: { tokenHash } })
  const now = new Date()

  if (!stored || stored.expiresAt < now) {
    return { error: 'invalid' }
  }

  if (stored.revokedAt) {
    if (stored.replacedByTokenId) {
      await tx.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: now },
      })
      return { error: 'reused' }
    }
    return { error: 'invalid' }
  }

  const successor = generateRefreshToken()
  const created = await tx.refreshToken.create({
    data: {
      userId: stored.userId,
      familyId: stored.familyId,
      tokenHash: successor.tokenHash,
      expiresAt: successor.expiresAt,
    },
  })

  await tx.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: now, replacedByTokenId: created.id },
  })

  return { raw: successor.raw, familyId: stored.familyId, userId: stored.userId }
}

/** Logout: kill this device's whole chain, leaving other devices signed in. */
export async function revokeFamily(rawToken, tx = prisma) {
  const stored = await tx.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(rawToken) },
  })
  if (!stored) return
  await tx.refreshToken.updateMany({
    where: { familyId: stored.familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

/** "Sign out everywhere" / after a password change. */
export async function revokeAllForUser(userId, tx = prisma) {
  await tx.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}
