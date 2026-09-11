import { prisma } from '../db/client.js'
import { hashPassword, verifyPassword } from './password.js'
import { issueRefreshToken } from './refresh-tokens.js'
import { signAccessToken } from './tokens.js'
import { unauthorized } from '../errors/http-errors.js'

let dummyHashPromise
function getDummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('not-a-real-password-000')
  return dummyHashPromise
}

export async function loginUser(email, password, tx = prisma) {
  const normalizedEmail = email.toLowerCase()
  const user = await tx.user.findUnique({ where: { email: normalizedEmail } })
  const hashToCheck = user ? user.passwordHash : await getDummyHash()
  const valid = await verifyPassword(password, hashToCheck)

  if (!user || !valid) {
    throw unauthorized('Invalid email or password')
  }

  const accessToken = signAccessToken(user.id)
  const { raw: refreshToken } = await issueRefreshToken(user.id, undefined, tx)

  return { user, accessToken, refreshToken }
}
