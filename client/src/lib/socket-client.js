import { io } from 'socket.io-client'
import {
  getAccessToken,
  getOrganizationId,
  refreshAccessToken,
  setAccessToken,
  setOrganizationId,
} from './api-client.js'

// B15-T4 (#47): the browser end of push. One authenticated socket per page,
// owned by the app shell via useRealtime — never constructed in pages.
//
// The handshake mirrors the T1 contract: JWT in `auth.token` (primary) with
// an optional `auth.orgId` tenant hint. Room derivation stays server-side;
// the client can never choose rooms.
const SOCKET_URL = (import.meta.env.VITE_API_ORIGIN || 'http://localhost:3000').replace(/\/$/, '')

// Fixed realtime vocabulary (server: REALTIME_EVENTS in
// server/src/lib/realtime/socket-server.js). Renaming is a cross-slice
// breaking change.
export const REALTIME_EVENTS = Object.freeze({
  JOB_CREATED: 'job.created',
  JOB_UPDATED: 'job.updated',
  JOB_ESCALATED: 'job.escalated',
  AGENT_MOVED: 'agent.moved',
})

// Binary connection state. Anything but 'connected' means the app is on the
// polling fallback (PostgreSQL truth), and the banner is visible.
export const CONNECTION_STATUS = Object.freeze({
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
})

// The in-memory access token, the organization hint, and the single-flight
// refresh live in api-client.js — one source of truth shared with the fetch
// path (server keeps tokens out of storage by decision: short-lived JWT in
// browser memory, refresh via httpOnly cookie). Re-exported here so
// socket/auth consumers keep a stable import; the implementation is not
// duplicated.
export { getAccessToken, getOrganizationId, setAccessToken, setOrganizationId }

const AUTH_ERROR_PATTERN = /expir|invalid.*token|unauthori|authentication/i

function isAuthError(error) {
  return AUTH_ERROR_PATTERN.test(error?.message ?? '')
}

let socket = null
let status = CONNECTION_STATUS.DISCONNECTED
let refreshAttempted = false
const statusListeners = new Set()

function setStatus(next) {
  if (status !== next) {
    status = next
    for (const listener of statusListeners) {
      listener(status)
    }
  }
}

export function getConnectionStatus() {
  return status
}

export function subscribeConnectionStatus(listener) {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

export function getSocket() {
  return socket
}

// Auth-as-function so every handshake (initial + automatic reconnects) sends
// the CURRENT token — a mid-session refresh is picked up without rebuilding
// the socket.
function currentAuth() {
  const token = getAccessToken()
  const organizationId = getOrganizationId()
  return organizationId ? { token, orgId: organizationId } : { token }
}

export function connectSocket() {
  if (socket) {
    if (!socket.connected) {
      socket.connect()
    }
    return socket
  }

  const next = io(SOCKET_URL, {
    // Dormant under vitest: unit tests drive a mocked io, and App.test must
    // not open real connections. Prod/dev behavior is untouched.
    autoConnect: import.meta.env.MODE !== 'test',
    auth: (send) => send(currentAuth()),
    reconnection: true,
  })

  next.on('connect', () => {
    refreshAttempted = false
    setStatus(CONNECTION_STATUS.CONNECTED)
  })

  next.on('disconnect', () => {
    setStatus(CONNECTION_STATUS.DISCONNECTED)
  })

  next.on('connect_error', async (error) => {
    if (isAuthError(error) && !refreshAttempted) {
      refreshAttempted = true
      try {
        await refreshAccessToken()
        next.connect()
        return
      } catch {
        // Refresh failed — fall through to disconnected (polling fallback).
      }
    }
    setStatus(CONNECTION_STATUS.DISCONNECTED)
  })

  socket = next
  return socket
}

// Lifecycle owner only (app shell logout/unmount, tests). Pages never call
// this — the hook intentionally has no disconnect-on-unmount so concurrent
// hook users share the one socket.
export function disconnectSocket() {
  const current = socket
  socket = null
  refreshAttempted = false
  if (current) {
    current.removeAllListeners()
    current.disconnect()
  }
  setStatus(CONNECTION_STATUS.DISCONNECTED)
}
