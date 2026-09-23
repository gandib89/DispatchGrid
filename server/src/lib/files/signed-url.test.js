import { describe, expect, it } from 'vitest'
import { PUT_URL_TTL_MS, signPutUrl, verifyPutRequest } from './signed-url.js'

const proof = { key: 'opaque-file-key', contentType: 'image/jpeg', sizeBytes: 2048 }

function signedRequest(upload, overrides = {}) {
  return {
    key: proof.key,
    method: upload.method,
    contentType: upload.conditions.contentType,
    sizeBytes: upload.conditions.sizeBytes,
    expiresAt: upload.expiresAt,
    signature: upload.signature,
    ...overrides,
  }
}

describe('conditional PUT signing', () => {
  it('signs a five-minute PUT whose unchanged conditions verify', () => {
    const now = Date.now()
    const upload = signPutUrl({ ...proof, now })

    expect(upload.method).toBe('PUT')
    expect(upload.expiresAt).toBe(now + PUT_URL_TTL_MS)
    expect(upload.expiresAt - now).toBe(5 * 60 * 1000)
    expect(upload.url).toContain(encodeURIComponent(proof.key))
    expect(upload.signature).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(verifyPutRequest(signedRequest(upload))).toEqual({ ok: true })
  })

  it('rejects a mutated content type at the verification boundary', () => {
    const upload = signPutUrl(proof)
    const result = verifyPutRequest(signedRequest(upload, { contentType: 'image/png' }))

    expect(result).toEqual({ ok: false, reason: 'condition_mismatch' })
  })

  it('rejects a mutated size at the verification boundary', () => {
    const upload = signPutUrl(proof)
    const result = verifyPutRequest(signedRequest(upload, { sizeBytes: proof.sizeBytes + 1 }))

    expect(result).toEqual({ ok: false, reason: 'condition_mismatch' })
  })

  it('rejects an expired signature', () => {
    const upload = signPutUrl({ ...proof, now: Date.now() - PUT_URL_TTL_MS - 1 })

    expect(verifyPutRequest(signedRequest(upload))).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a non-PUT method', () => {
    const upload = signPutUrl(proof)

    expect(verifyPutRequest(signedRequest(upload, { method: 'GET' }))).toEqual({
      ok: false,
      reason: 'method_not_allowed',
    })
  })
})
