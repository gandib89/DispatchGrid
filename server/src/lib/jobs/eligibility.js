// Pure eligibility predicates. No Express, Prisma, Redis, or Gemini imports.
// Ranking must only receive agents that pass these hard rules.

export function effectiveCapFor(membership, defaultCap) {
  if (membership?.concurrentJobCap !== null && membership?.concurrentJobCap !== undefined) {
    return membership.concurrentJobCap
  }
  return defaultCap
}

export function checkAgentEligibility({
  membership,
  organizationId,
  activeJobCount,
  defaultCap,
}) {
  const reasons = []

  const membershipOrgId = membership?.organizationId
  if (!membership || membershipOrgId !== organizationId) {
    reasons.push('wrong_organization')
  }

  const roleName = membership?.role?.name || membership?.roleName
  if (roleName !== 'AGENT') {
    reasons.push('wrong_role')
  }

  if (membership?.isAvailable !== true) {
    reasons.push('unavailable')
  }

  const effectiveCap = effectiveCapFor(membership, defaultCap)
  if (
    typeof activeJobCount === 'number' &&
    typeof effectiveCap === 'number' &&
    activeJobCount >= effectiveCap
  ) {
    reasons.push('at_cap')
  }

  return { eligible: reasons.length === 0, reasons, effectiveCap }
}
