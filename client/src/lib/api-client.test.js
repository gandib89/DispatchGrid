import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test/helpers.js'
import {
  ApiError,
  apiRequest,
  getAccessToken,
  setAccessToken,
  setOrganizationId,
} from './api-client.js'
import {
  getAccessToken as socketGetAccessToken,
  setAccessToken as socketSetAccessToken,
} from './socket-client.js'

function unauthorizedResponse(message = 'Token expired') {
  return jsonResponse({ error: { code: 'unauthorized', message } }, 401)
}

function headerOf(call, name) {
  return new Headers(call[1]?.headers).get(name)
}

function callsTo(fetch, fragment) {
  return fetch.mock.calls.filter(([url]) => String(url).includes(fragment))
}

beforeEach(() => {
  setAccessToken(null)
})

afterEach(() => {
  setAccessToken(null)
  setOrganizationId(null)
  vi.unstubAllGlobals()
})

describe('access token', () => {
  it('injects the in-memory token as a Bearer header and drops it when cleared', async () => {
    const fetch = vi.fn(async () => jsonResponse({ id: 'user-1' }))
    vi.stubGlobal('fetch', fetch)

    setAccessToken('token-1')
    await apiRequest('/api/v1/auth/me')
    expect(headerOf(fetch.mock.calls[0], 'authorization')).toBe('Bearer token-1')

    setAccessToken(null)
    await apiRequest('/api/v1/auth/me')
    expect(headerOf(fetch.mock.calls[1], 'authorization')).toBeNull()
  })

  it('shares one token source between api-client and socket-client', () => {
    expect(socketSetAccessToken).toBe(setAccessToken)
    expect(socketGetAccessToken).toBe(getAccessToken)
    socketSetAccessToken('from-socket')
    expect(getAccessToken()).toBe('from-socket')
  })
})

describe('organization header', () => {
  it('attaches x-organization-id when an organization is set and omits it when not', async () => {
    const fetch = vi.fn(async () => jsonResponse({ jobs: [] }))
    vi.stubGlobal('fetch', fetch)

    await apiRequest('/api/v1/jobs')
    expect(headerOf(fetch.mock.calls[0], 'x-organization-id')).toBeNull()

    setOrganizationId('org-1')
    await apiRequest('/api/v1/jobs')
    expect(headerOf(fetch.mock.calls[1], 'x-organization-id')).toBe('org-1')

    setOrganizationId(null)
    await apiRequest('/api/v1/jobs')
    expect(headerOf(fetch.mock.calls[2], 'x-organization-id')).toBeNull()
  })
})

describe('401 refresh and replay', () => {
  it('runs exactly one refresh for concurrent 401s, then replays each request once', async () => {
    setAccessToken('stale-token')
    const attempts = new Map()
    // Snapshot auth per call: send() reuses one Headers object across the
    // replay, so inspecting call args later would only see the fresh token.
    const jobAuth = []
    const fetch = vi.fn(async (url, init) => {
      const target = String(url)
      const auth = new Headers(init.headers).get('authorization')
      if (target.endsWith('/api/v1/auth/refresh')) {
        return jsonResponse({ accessToken: 'fresh-token' })
      }
      if (target.endsWith('/api/v1/jobs')) jobAuth.push(auth)
      const count = (attempts.get(target) ?? 0) + 1
      attempts.set(target, count)
      return count === 1 ? unauthorizedResponse() : jsonResponse({ ok: true })
    })
    vi.stubGlobal('fetch', fetch)

    const [jobs, members] = await Promise.all([
      apiRequest('/api/v1/jobs'),
      apiRequest('/api/v1/members'),
    ])

    expect(jobs).toEqual({ ok: true })
    expect(members).toEqual({ ok: true })
    expect(callsTo(fetch, '/api/v1/auth/refresh')).toHaveLength(1)
    expect([...attempts.values()]).toEqual([2, 2])
    expect(getAccessToken()).toBe('fresh-token')
    expect(jobAuth).toEqual(['Bearer stale-token', 'Bearer fresh-token'])
  })

  it('skips the replay and surfaces the original 401 when refresh fails', async () => {
    setAccessToken('stale-token')
    const fetch = vi.fn(async (url) => {
      const target = String(url)
      if (target.endsWith('/api/v1/auth/refresh')) {
        return jsonResponse(
          { error: { code: 'unauthorized', message: 'Refresh token invalid' } },
          401,
        )
      }
      return unauthorizedResponse()
    })
    vi.stubGlobal('fetch', fetch)

    const results = await Promise.allSettled([
      apiRequest('/api/v1/jobs'),
      apiRequest('/api/v1/members'),
    ])

    expect(callsTo(fetch, '/api/v1/auth/refresh')).toHaveLength(1)
    expect(callsTo(fetch, '/api/v1/jobs')).toHaveLength(1)
    expect(callsTo(fetch, '/api/v1/members')).toHaveLength(1)
    for (const result of results) {
      expect(result.status).toBe('rejected')
      expect(result.reason).toBeInstanceOf(ApiError)
      expect(result.reason.status).toBe(401)
      expect(result.reason.code).toBe('unauthorized')
      expect(result.reason.message).toBe('Token expired')
    }
  })
})

describe('idempotency keys', () => {
  it('keeps the identical key across the 401 replay', async () => {
    setAccessToken('stale-token')
    let jobsHit = 0
    const fetch = vi.fn(async (url) => {
      const target = String(url)
      if (target.endsWith('/api/v1/auth/refresh')) {
        return jsonResponse({ accessToken: 'fresh-token' })
      }
      jobsHit += 1
      return jobsHit === 1 ? unauthorizedResponse() : jsonResponse({ id: 'job-1' })
    })
    vi.stubGlobal('fetch', fetch)

    const job = await apiRequest('/api/v1/jobs', { method: 'POST', body: '{"title":"Pump"}' })
    expect(job).toEqual({ id: 'job-1' })

    const jobCalls = callsTo(fetch, '/api/v1/jobs')
    expect(jobCalls).toHaveLength(2)
    const [firstKey, replayKey] = jobCalls.map((call) => headerOf(call, 'idempotency-key'))
    expect(firstKey).toBeTruthy()
    expect(replayKey).toBe(firstKey)
  })

  it('reuses a caller-supplied key across client retries and generates a distinct key per new mutation', async () => {
    const fetch = vi.fn(async () => jsonResponse({ id: 'job-1' }))
    vi.stubGlobal('fetch', fetch)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await apiRequest('/api/v1/jobs', {
        method: 'POST',
        body: '{"title":"Pump"}',
        headers: { 'Idempotency-Key': 'logical-op-1' },
      })
    }
    await apiRequest('/api/v1/jobs', { method: 'POST', body: '{"title":"Valve"}' })
    await apiRequest('/api/v1/jobs', { method: 'POST', body: '{"title":"Meter"}' })

    const keys = fetch.mock.calls.map((call) => headerOf(call, 'idempotency-key'))
    expect(keys[0]).toBe('logical-op-1')
    expect(keys[1]).toBe('logical-op-1')
    expect(keys[2]).toBeTruthy()
    expect(keys[3]).toBeTruthy()
    expect(keys[2]).not.toBe(keys[3])
    expect(keys[2]).not.toBe('logical-op-1')
  })

  it('sends the identical Idempotency-Key from the explicit idempotencyKey option across separate calls', async () => {
    const fetch = vi.fn(async () => jsonResponse({ id: 'job-1' }))
    vi.stubGlobal('fetch', fetch)

    const mutation = { method: 'POST', body: '{"title":"Pump"}', idempotencyKey: 'logical-op-7' }
    await apiRequest('/api/v1/jobs', mutation)
    await apiRequest('/api/v1/jobs', mutation)

    const keys = fetch.mock.calls.map((call) => headerOf(call, 'idempotency-key'))
    expect(keys).toEqual(['logical-op-7', 'logical-op-7'])
  })

  it('does not attach a key to reads', async () => {
    const fetch = vi.fn(async () => jsonResponse({ jobs: [] }))
    vi.stubGlobal('fetch', fetch)

    await apiRequest('/api/v1/jobs')
    expect(headerOf(fetch.mock.calls[0], 'idempotency-key')).toBeNull()
  })
})

describe('error envelope', () => {
  it('parses {error:{code,message,details}} into a typed ApiError', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: 'validation_error',
            message: 'Title is required',
            details: { title: 'required' },
          },
        },
        400,
      ),
    )
    vi.stubGlobal('fetch', fetch)

    const error = await apiRequest('/api/v1/jobs', { method: 'POST', body: '{}' }).then(
      () => null,
      (err) => err,
    )

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ApiError')
    expect(error.status).toBe(400)
    expect(error.code).toBe('validation_error')
    expect(error.message).toBe('Title is required')
    expect(error.details).toEqual({ title: 'required' })
  })
})

describe('architectural invariants', () => {
  const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

  function listSourceFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return listSourceFiles(full)
      return /\.(?:js|jsx)$/.test(entry.name) ? [full] : []
    })
  }

  function isTestFile(file) {
    return /\.test\.(?:js|jsx)$/.test(file) || file.split(path.sep).includes('test')
  }

  function offenders(pattern) {
    return listSourceFiles(SRC_ROOT)
      .filter((file) => !isTestFile(file))
      .filter((file) => !file.endsWith(path.join('lib', 'api-client.js')))
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC_ROOT, file))
  }

  it('only the api client module calls fetch', () => {
    expect(offenders(/\bfetch\s*\(/)).toEqual([])
  })

  it('never touches localStorage or sessionStorage', () => {
    expect(offenders(/\b(?:localStorage|sessionStorage)\b/)).toEqual([])
  })
})
