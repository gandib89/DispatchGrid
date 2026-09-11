const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN || 'http://localhost:3000').replace(
  /\/$/,
  '',
)

export class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers)

  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  const response = await fetch(`${API_ORIGIN}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  })

  const isJson = response.headers.get('content-type')?.includes('application/json')
  const body = response.status === 204 ? null : isJson ? await response.json() : await response.text()

  if (!response.ok) {
    const apiError = typeof body === 'object' && body ? body.error : null
    throw new ApiError(apiError?.message || `Request failed with status ${response.status}`, {
      status: response.status,
      code: apiError?.code,
      details: apiError?.details,
    })
  }

  return body
}
