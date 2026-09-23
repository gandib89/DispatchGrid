// Human-readable copy per envelope code, used when the server message is
// missing. Field-level details ride alongside the general message.
const FALLBACKS = {
  validation_error: 'Please correct the highlighted fields.',
  email_taken: 'That email is already registered.',
  unauthorized: 'Invalid email or password.',
}

export function authErrorMessage(error) {
  if (!error) return null
  return error.message || FALLBACKS[error.code] || 'Something went wrong. Please try again.'
}

export function fieldErrors(error) {
  if (error?.code !== 'validation_error' || !error.details || typeof error.details !== 'object') {
    return {}
  }
  const fields = {}
  for (const [key, value] of Object.entries(error.details)) {
    if (typeof value === 'string') fields[key] = value
    else if (Array.isArray(value)) fields[key] = value.join(', ')
    else if (value && typeof value.message === 'string') fields[key] = value.message
  }
  return fields
}
