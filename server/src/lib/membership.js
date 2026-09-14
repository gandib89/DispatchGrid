// Shared org-membership selection (B15 review). resolve-tenant.js and the
// socket handshake derived the join/actor target with duplicated branches;
// this single pure selector owns the choice, no behavior change. Callers map
// `reason` to their own error shape (HTTP errors vs handshake errors).
export function findOrgMembership(memberships, requestedOrgId) {
  const list = memberships ?? []
  if (list.length === 0) {
    return { membership: null, reason: 'no-membership' }
  }
  if (requestedOrgId) {
    const membership = list.find((item) => item.organizationId === requestedOrgId) ?? null
    return membership ? { membership, reason: null } : { membership: null, reason: 'not-found' }
  }
  if (list.length === 1) {
    return { membership: list[0], reason: null }
  }
  return { membership: null, reason: 'selection-required' }
}
