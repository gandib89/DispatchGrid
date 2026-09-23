import crypto from 'node:crypto'
import { env } from '../../env.js'

// Conditional-signature boundary (B16): a five-minute PUT URL whose
// content-type and size conditions travel inside the HMAC, so the verifier
// (standing in for storage) rejects a mutated type or size without re-running
// API validation. No real GCS wiring: @google-cloud/storage stays untouched
// until a provider ticket; this module is the only seam that changes.

export const PUT_URL_TTL_MS = 5 * 60 * 1000

// ponytail: derives the stub signing key from JWT_SECRET via HKDF; dedicated storage signing key when real GCS wiring lands.
const signingKey = Buffer.from(
  crypto.hkdfSync(
    'sha256',
    Buffer.from(env.JWT_SECRET),
    Buffer.from('dispatchgrid'),
    Buffer.from('proof-put-url-v1'),
    32,
  ),
)

function canonicalString({ key, expiresAt, contentType, sizeBytes }) {
  return ['PUT', key, String(expiresAt), contentType, String(sizeBytes)].join('\n')
}

function signatureFor(parts) {
  return crypto.createHmac('sha256', signingKey).update(canonicalString(parts)).digest('base64url')
}

export function signPutUrl({ key, contentType, sizeBytes, now = Date.now() }) {
  const expiresAt = now + PUT_URL_TTL_MS
  const signature = signatureFor({ key, expiresAt, contentType, sizeBytes })
  const bucket = env.GCS_UPLOAD_BUCKET || 'dispatchgrid-proof-bucket'
  const url =
    `https://storage.googleapis.com/${bucket}/${encodeURIComponent(key)}` +
    `?expires=${expiresAt}&signature=${encodeURIComponent(signature)}`
  return {
    method: 'PUT',
    url,
    expiresAt,
    signature,
    conditions: { contentType, sizeBytes },
  }
}

export function verifyPutRequest({
  key,
  method,
  contentType,
  sizeBytes,
  expiresAt,
  signature,
  now = Date.now(),
}) {
  if (method !== 'PUT') {
    return { ok: false, reason: 'method_not_allowed' }
  }
  const expiry = Number(expiresAt)
  if (!Number.isFinite(expiry) || expiry < now) {
    return { ok: false, reason: 'expired' }
  }
  const expected = Buffer.from(signatureFor({ key, expiresAt: expiry, contentType, sizeBytes }))
  const given = Buffer.from(String(signature ?? ''))
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'condition_mismatch' }
  }
  return { ok: true }
}
