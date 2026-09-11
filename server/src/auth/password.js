import argon2 from 'argon2'

const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
}

export function hashPassword(plain) {
  return argon2.hash(plain, OPTIONS)
}

export function verifyPassword(plain, hashed) {
  return argon2.verify(hashed, plain)
}
