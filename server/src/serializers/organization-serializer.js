function toIso(value) {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function serializeOrganization(organization) {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    defaultConcurrentJobCap: organization.defaultConcurrentJobCap,
    createdAt: toIso(organization.createdAt),
    updatedAt: toIso(organization.updatedAt),
  }
}

export function serializeMembership(membership) {
  return {
    id: membership.id,
    organizationId: membership.organizationId,
    userId: membership.userId,
    roleId: membership.roleId,
    roleName: membership.role?.name,
    isAvailable: membership.isAvailable,
    concurrentJobCap: membership.concurrentJobCap,
    user: membership.user
      ? {
          id: membership.user.id,
          email: membership.user.email,
          displayName: membership.user.displayName,
        }
      : undefined,
    createdAt: toIso(membership.createdAt),
    updatedAt: toIso(membership.updatedAt),
  }
}

// Never includes the token or its hash: the plaintext exists only in the
// issue return value and the queue payload; the hash never leaves PostgreSQL.
export function serializeInvitation(invitation) {
  return {
    id: invitation.id,
    organizationId: invitation.organizationId,
    email: invitation.email,
    expiresAt: toIso(invitation.expiresAt),
    acceptedAt: toIso(invitation.acceptedAt),
    createdAt: toIso(invitation.createdAt),
    updatedAt: toIso(invitation.updatedAt),
  }
}
