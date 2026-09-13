import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('socket.io-client', () => ({ io: vi.fn() }))

import { io } from 'socket.io-client'
import {
  connectSocket,
  disconnectSocket,
  getAccessToken,
  getConnectionStatus,
  setAccessToken,
} from './socket-client.js'

function createFakeSocket() {
  const handlers = new Map()
  return {
    connected: false,
    on: vi.fn((event, fn) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
    }),
    off: vi.fn(),
    removeAllListeners: vi.fn(() => handlers.clear()),
    disconnect: vi.fn(),
    connect: vi.fn(),
    emitLocal(event, payload) {
      for (const fn of handlers.get(event) ?? []) {
        fn(payload)
      }
    },
    authOf() {
      let out = null
      io.mock.calls.at(-1)[1].auth((value) => {
        out = value
      })
      return out
    },
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  setAccessToken(null)
})

afterEach(() => {
  disconnectSocket()
  vi.unstubAllGlobals()
})

describe('socket-client', () => {
  it('keeps a single socket instance', () => {
    io.mockReturnValue(createFakeSocket())
    const first = connectSocket()
    expect(connectSocket()).toBe(first)
    expect(io).toHaveBeenCalledTimes(1)
  })

  it('sends the current access token on every handshake', () => {
    const fake = createFakeSocket()
    io.mockReturnValue(fake)
    setAccessToken('token-one')
    connectSocket()
    expect(fake.authOf()).toEqual({ token: 'token-one' })

    setAccessToken('token-two')
    expect(fake.authOf()).toEqual({ token: 'token-two' })
    expect(getAccessToken()).toBe('token-two')
  })

  it('refreshes once on auth failure then gives up instead of looping', async () => {
    const fake = createFakeSocket()
    io.mockReturnValue(fake)
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ accessToken: 'fresh-token' }))
    vi.stubGlobal('fetch', fetch)
    setAccessToken('expired-token')
    connectSocket()

    await vi.waitFor(() => {
      fake.emitLocal('connect_error', new Error('Invalid or expired access token'))
    })
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalledTimes(1))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toContain('/api/v1/auth/refresh')
    expect(getAccessToken()).toBe('fresh-token')

    fake.emitLocal('connect_error', new Error('Invalid or expired access token'))
    await Promise.resolve()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(getConnectionStatus()).toBe('disconnected')
  })

  it('does not refresh on non-auth connection errors', async () => {
    const fake = createFakeSocket()
    io.mockReturnValue(fake)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    connectSocket()

    fake.emitLocal('connect_error', new Error('server went away'))
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
    expect(fake.connect).not.toHaveBeenCalled()
    expect(getConnectionStatus()).toBe('disconnected')
  })
})
