export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function createHttpError(status, code, defaultMessage) {
  return (message = defaultMessage, details) =>
    new HttpError(status, code, message, details)
}

export const badRequest = createHttpError(400, 'validation_error', 'The request is invalid')
export const unauthorized = createHttpError(401, 'unauthorized', 'Authentication is required')
export const forbidden = createHttpError(403, 'forbidden', 'This action is not allowed')
export const notFound = createHttpError(404, 'not_found', 'The requested resource was not found')
export const conflict = createHttpError(409, 'conflict', 'The request conflicts with current state')

export const versionConflict = createHttpError(
  409,
  'version_conflict',
  'The job changed since it was read',
)
export const alreadyAssigned = createHttpError(
  409,
  'already_assigned',
  'The job already has an active assignment',
)
export const idempotencyInProgress = createHttpError(
  409,
  'idempotency_in_progress',
  'The same idempotent request is still running',
)
export const attachmentLimitReached = createHttpError(
  409,
  'attachment_limit_reached',
  'The job already has the maximum number of attachments',
)
export const fileTooLarge = createHttpError(
  413,
  'file_too_large',
  'The declared file size exceeds the allowed maximum',
)
export const unsupportedMediaType = createHttpError(
  415,
  'unsupported_media_type',
  'The content type is not allowed for proof uploads',
)
export const invalidTransition = createHttpError(
  422,
  'invalid_transition',
  'The requested status transition is not allowed',
)
export const agentNotEligible = createHttpError(
  422,
  'agent_not_eligible',
  'The agent is not eligible for this job',
)
export const idempotencyKeyReuse = createHttpError(
  422,
  'idempotency_key_reuse',
  'The idempotency key was already used with a different request',
)
export const rateLimited = createHttpError(429, 'rate_limited', 'Too many requests')

export function errorEnvelope(error) {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  }
}
