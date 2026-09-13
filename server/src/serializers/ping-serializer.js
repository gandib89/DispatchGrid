function toIso(value) {
  if (value === null || value === undefined) return value === null ? null : undefined
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toNumber(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'object' && typeof value.toNumber === 'function') {
    return value.toNumber()
  }
  return Number(value)
}

export function serializePing(ping) {
  return {
    id: ping.id,
    organizationId: ping.organizationId,
    agentId: ping.agentId,
    jobId: ping.jobId ?? null,
    latitude: toNumber(ping.latitude),
    longitude: toNumber(ping.longitude),
    accuracy: ping.accuracy,
    recordedAt: toIso(ping.recordedAt),
    createdAt: toIso(ping.createdAt),
  }
}

// B14-T4 (#41): latest-position read shape. The hot cache holds no id or
// createdAt (it is a value, not a row), so both sources serialize to the
// same position envelope — only `source` differs. jobId rides the cached
// payload when present (older entries predate it) and is always visible
// per A-8; it never leaks across tenants because every read is org-scoped.
export function serializePosition(position, source) {
  return {
    organizationId: position.organizationId,
    agentId: position.agentId,
    jobId: position.jobId ?? null,
    latitude: toNumber(position.latitude),
    longitude: toNumber(position.longitude),
    accuracy: position.accuracy,
    recordedAt: toIso(position.recordedAt),
    source,
  }
}
