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

export function serializeJob(job) {
  return {
    id: job.id,
    organizationId: job.organizationId,
    reference: job.reference,
    title: job.title,
    description: job.description ?? null,
    address: job.address ?? null,
    latitude: toNumber(job.latitude),
    longitude: toNumber(job.longitude),
    priority: job.priority,
    status: job.status,
    slaState: job.slaState ?? null,
    currentAssigneeId: job.currentAssigneeId ?? null,
    createdById: job.createdById ?? null,
    version: job.version,
    dueAt: toIso(job.dueAt),
    completedAt: toIso(job.completedAt),
    createdAt: toIso(job.createdAt),
    updatedAt: toIso(job.updatedAt),
  }
}

export function serializeAssignment(assignment) {
  return {
    id: assignment.id,
    jobId: assignment.jobId,
    agentId: assignment.agentId,
    state: assignment.state,
    createdAt: toIso(assignment.createdAt),
    updatedAt: toIso(assignment.updatedAt),
  }
}

export function serializeEvent(event) {
  return {
    id: event.id,
    jobId: event.jobId,
    actorUserId: event.actorUserId ?? null,
    fromStatus: event.fromStatus ?? null,
    toStatus: event.toStatus,
    reason: event.reason ?? null,
    createdAt: toIso(event.createdAt),
  }
}

export function serializeAttachment(attachment) {
  return {
    id: attachment.id,
    organizationId: attachment.organizationId,
    jobId: attachment.jobId,
    uploaderId: attachment.uploaderId,
    fileKey: attachment.fileKey,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    createdAt: toIso(attachment.createdAt),
    updatedAt: toIso(attachment.updatedAt),
  }
}

export function serializeUpload(upload) {
  return {
    method: upload.method,
    url: upload.url,
    expiresAt: toIso(upload.expiresAt),
    conditions: {
      contentType: upload.conditions.contentType,
      sizeBytes: upload.conditions.sizeBytes,
    },
  }
}
