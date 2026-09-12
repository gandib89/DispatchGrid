function toIso(value) {
  if (value === null || value === undefined) return value === null ? null : undefined
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function serializeSlaPolicy(policy) {
  return {
    id: policy.id,
    organizationId: policy.organizationId,
    name: policy.name,
    warningMinutesBefore: policy.warningMinutesBefore,
    breachMinutesAfter: policy.breachMinutesAfter,
    createdAt: toIso(policy.createdAt),
    updatedAt: toIso(policy.updatedAt),
  }
}
