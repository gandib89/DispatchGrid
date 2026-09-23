import crypto from 'node:crypto'
import { prisma } from '../db/client.js'
import {
  attachmentLimitReached,
  badRequest,
  fileTooLarge,
  forbidden,
  unsupportedMediaType,
} from '../errors/http-errors.js'
import { signPutUrl } from '../lib/files/signed-url.js'
import { PROOF_CONTENT_TYPES, PROOF_MAX_SIZE_BYTES } from '../../../shared/job-schema.js'
import { requirePermission, runIdempotent, scopedJob, toPlain } from './transaction.js'

const MAX_ATTACHMENTS_PER_JOB = 3

// B16-T1: upload-URL issuance. Scope first (cross-org 404), then permission
// (403), then the durable cap/ownership checks inside the idempotent
// transaction. The Attachment row is recorded from the first URL — object
// existence is deliberately not verified (accepted dangling-key gap), and the
// five-minute PUT signs content-type and size into the signature so storage
// would reject mutations even if API validation were bypassed.

export async function issueUploadUrl(actor, jobId, input = {}, options = {}) {
  await scopedJob(prisma, actor, jobId)
  requirePermission(actor, 'job.respond')

  const contentType = input?.contentType
  if (typeof contentType !== 'string' || contentType.length === 0 || contentType.length > 128) {
    throw badRequest('contentType must be a non-empty string of at most 128 characters')
  }
  if (!PROOF_CONTENT_TYPES.includes(contentType)) {
    throw unsupportedMediaType(`Content type ${contentType} is not allowed`)
  }
  const sizeBytes = input?.sizeBytes
  if (!Number.isInteger(sizeBytes) || sizeBytes < 1) {
    throw badRequest('sizeBytes must be a positive integer')
  }
  if (sizeBytes > PROOF_MAX_SIZE_BYTES) {
    throw fileTooLarge(`Declared size exceeds ${PROOF_MAX_SIZE_BYTES} bytes`)
  }

  const { data, replay } = await runIdempotent({
    operation: 'job.upload_url',
    organizationId: actor.organizationId,
    key: options.key,
    fingerprintSource: { jobId, contentType, sizeBytes },
    responseStatus: 201,
    execute: async (tx) => {
      const job = await scopedJob(tx, actor, jobId)
      if (job.currentAssigneeId !== actor.userId) {
        throw forbidden('Only the assigned agent can perform this action')
      }
      // ponytail: count-then-insert is not serialized per job, so concurrent issuances can exceed the cap; lock the job row FOR UPDATE if that ceiling ever matters.
      const recorded = await tx.attachment.count({
        where: { organizationId: actor.organizationId, jobId },
      })
      if (recorded >= MAX_ATTACHMENTS_PER_JOB) {
        throw attachmentLimitReached(`A job can hold at most ${MAX_ATTACHMENTS_PER_JOB} attachments`)
      }
      const fileKey = crypto.randomUUID()
      const attachment = await tx.attachment.create({
        data: {
          organizationId: actor.organizationId,
          jobId,
          uploaderId: actor.userId,
          fileKey,
          contentType,
          sizeBytes,
        },
      })
      return {
        attachment: toPlain(attachment),
        upload: toPlain(signPutUrl({ key: fileKey, contentType, sizeBytes })),
      }
    },
  })

  return { ...data, replay }
}
