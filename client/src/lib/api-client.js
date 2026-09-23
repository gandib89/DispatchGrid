const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN || 'http://localhost:3000').replace(/\/$/, '')

const REFRESH_PATH = '/api/v1/auth/refresh'
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

// The single in-memory access token — the one source of truth shared with
// the socket handshake (socket-client imports it). Never written to
// storage; the httpOnly refresh cookie is the server's half.
let accessToken = null

export function setAccessToken(token) {
  accessToken = token ?? null
}

export function getAccessToken() {
  return accessToken
}

// Single-flight refresh: every concurrent 401 (and socket auth failure)
// awaits the same in-flight POST; the slot clears once settled.
let refreshInFlight = null

export function refreshAccessToken() {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

async function performRefresh() {
  // Raw fetch on purpose: cookie-authenticated, no Authorization header,
  // and a failed refresh can never re-enter the 401 path.
  const response = await fetch(`${API_ORIGIN}${REFRESH_PATH}`, {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  const body = await readBody(response)
  setAccessToken(body?.accessToken ?? null)
  return body?.accessToken ?? null
}

async function readBody(response) {
  const isJson = response.headers.get('content-type')?.includes('application/json')
  const body = response.status === 204 ? null : isJson ? await response.json() : await response.text()

  if (!response.ok) {
    const envelope = typeof body === 'object' && body ? body.error : null
    throw new ApiError(envelope?.message || `Request failed with status ${response.status}`, {
      status: response.status,
      code: envelope?.code,
      details: envelope?.details,
    })
  }

  return body
}

export async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers)

  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  // One key per logical mutation: generated here when absent, reused by the
  // 401 replay below (same Headers object), and kept stable across client
  // retries when the caller passes its Idempotency-Key back in.
  const method = (options.method ?? 'GET').toUpperCase()
  if (MUTATING_METHODS.has(method) && !headers.has('Idempotency-Key')) {
    headers.set('Idempotency-Key', crypto.randomUUID())
  }

  const send = () => {
    const token = getAccessToken()
    if (token) headers.set('authorization', `Bearer ${token}`)
    else headers.delete('authorization')
    return fetch(`${API_ORIGIN}${path}`, {
      ...options,
      headers,
      credentials: 'include',
    })
  }

  let response = await send()

  // One 401 -> one single-flight refresh -> exactly one replay on the same
  // headers (identical Idempotency-Key, fresh Bearer). A failed refresh
  // surfaces the original 401 below; a replayed 401 is never refreshed again.
  if (response.status === 401) {
    try {
      await refreshAccessToken()
      response = await send()
    } catch {
      // Refresh failed — fall through and surface the original 401.
    }
  }

  return readBody(response)
}
