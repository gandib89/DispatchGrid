import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { env } from '../env.js';

// TWO TOKENS, TWO JOBS:
//
//   ACCESS  — a JWT. Short-lived (15m), stateless, verified with no DB hit.
//             Cannot be revoked, which is exactly why it is short.
//             Lives in browser MEMORY only.
//
//   REFRESH — opaque random bytes. Long-lived (7d), stored server-side as a
//             SHA-256 hash, revocable, rotated on every use.
//             Lives in an httpOnly cookie only.

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function signAccessToken(userId, extraClaims = {}) {
  return jwt.sign({ sub: userId, jti: randomUUID(), ...extraClaims }, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

export function verifyAccessToken(token) {

  return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
}

export function generateRefreshToken() {
  const raw = randomBytes(32).toString('base64url');
  return {
    raw,                                   // sent to the client, never stored
    tokenHash: hashRefreshToken(raw),      // stored, never sent
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  };
}

export function hashRefreshToken(raw) {
  return createHash('sha256').update(raw).digest('hex');
}