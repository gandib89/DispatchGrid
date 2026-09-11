import crypto from 'node:crypto'
import { idempotencyInProgress, idempotencyKeyReuse } from '../errors/http-errors.js'

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export function fingerprintRequest(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex')
}

function stableStringify(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    if (value instanceof Date) return JSON.stringify(value.toISOString())
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// A uniqueness conflict aborts the surrounding Postgres transaction. Run the
// fallible insert inside a savepoint so the caller's transaction stays usable.
export async function withSavepoint(tx, work) {
  const name = `sp_${crypto.randomBytes(8).toString('hex')}`
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`)
  try {
    const result = await work()
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`)
    return result
  } catch (error) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`)
    throw error
  }
}

function isUniqueViolation(error) {
  return error?.code === 'P2002'
}

export async function reserveKey(tx, { organizationId, operation, key, fingerprint, ttlMs }) {
  const attempt = () =>
    tx.idempotencyKey.create({
      data: {
        organizationId,
        operation,
        key,
        requestFingerprint: fingerprint,
        status: 'IN_PROGRESS',
        expiresAt: new Date(Date.now() + (ttlMs ?? DEFAULT_TTL_MS)),
      },
    })

  try {
    const record = await withSavepoint(tx, attempt)
    return { outcome: 'proceed', record }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }

  const existing = await tx.idempotencyKey.findUnique({
    where: { organizationId_operation_key: { organizationId, operation, key } },
  })
  if (!existing) {
    const record = await attempt()
    return { outcome: 'proceed', record }
  }

  if (existing.expiresAt < new Date()) {
    await tx.idempotencyKey.delete({ where: { id: existing.id } })
    const record = await attempt()
    return { outcome: 'proceed', record }
  }

  if (existing.status === 'COMPLETED') {
    if (existing.requestFingerprint === fingerprint) {
      return { outcome: 'replay', record: existing }
    }
    throw idempotencyKeyReuse('This idempotency key was already used with a different request')
  }

  throw idempotencyInProgress('An identical request is still being processed')
}

export async function completeKey(tx, id, responseStatus, responseBody) {
  await tx.idempotencyKey.update({
    where: { id },
    data: { status: 'COMPLETED', responseStatus, responseBody },
  })
}

export async function dropKey(tx, id) {
  await tx.idempotencyKey.deleteMany({ where: { id } })
}
