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
