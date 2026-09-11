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
