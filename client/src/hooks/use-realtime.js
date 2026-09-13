import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  CONNECTION_STATUS,
  REALTIME_EVENTS,
  connectSocket,
  getConnectionStatus,
  subscribeConnectionStatus,
} from '../lib/socket-client.js'

// B15-T4 (#47): cache-patch hook. Subscribes to the T2 event shapes and
// patches TanStack Query entries in place — never a REST fetch per event
// (movement bursts stay fetch-free; PostgreSQL stays the correctness path).
//
// Canonical keys push lands on (B18 must read through these):
//   ['jobs']            job board list (array, or { jobs: [...] })
//   ['job', id]         job detail
//   ['positions']       map of agentId -> position
//   ['positions', id]   single agent position
// Rule: patch only entries already in cache; the single reconnect
// reconciliation refetches everything missed.
export const JOB_BOARD_KEY = ['jobs']
export const POSITIONS_KEY = ['positions']
export const jobDetailKey = (jobId) => ['job', jobId]
export const agentPositionKey = (agentId) => ['positions', agentId]

// 15s polling cadence == query-client staleTime (single source of truth lives
// there; this mirror is only the refetchInterval value T5 consumers pass).
export const POLLING_INTERVAL_MS = 15_000

function upsertJobIntoList(data, job) {
  if (Array.isArray(data)) {
    return data.some((item) => item?.id === job.id)
      ? data.map((item) => (item?.id === job.id ? job : item))
      : [job, ...data]
  }
  if (data && Array.isArray(data.jobs)) {
    return {
      ...data,
      jobs: data.jobs.some((item) => item?.id === job.id)
        ? data.jobs.map((item) => (item?.id === job.id ? job : item))
        : [job, ...data.jobs],
    }
  }
  return data
}

export function patchJob(client, job) {
  if (!job?.id) return
  for (const [key, data] of client.getQueriesData({ queryKey: JOB_BOARD_KEY })) {
    const next = upsertJobIntoList(data, job)
    if (next !== data) {
      client.setQueryData(key, next)
    }
  }
  if (client.getQueryData(jobDetailKey(job.id)) !== undefined) {
    client.setQueryData(jobDetailKey(job.id), job)
  }
}

export function patchPosition(client, payload) {
  const { agentId, latitude, longitude, recordedAt } = payload ?? {}
  if (!agentId) return
  const position = { agentId, latitude, longitude, recordedAt }
  if (client.getQueryData(agentPositionKey(agentId)) !== undefined) {
    client.setQueryData(agentPositionKey(agentId), (old) => ({ ...old, ...position }))
  }
  if (client.getQueryData(POSITIONS_KEY) !== undefined) {
    client.setQueryData(POSITIONS_KEY, (old) => {
      if (!old || Array.isArray(old)) return old
      return { ...old, [agentId]: { ...old[agentId], ...position } }
    })
  }
}

// Single dispatch for events: created/updated/escalated all carry `job`
// (updated adds from/to/actor context, escalated adds threshold/slaState —
// context, not cache state); moved carries agent + coords + timestamp.
export function patchRealtimeCache(client, event, payload) {
  switch (event) {
    case REALTIME_EVENTS.JOB_CREATED:
    case REALTIME_EVENTS.JOB_UPDATED:
    case REALTIME_EVENTS.JOB_ESCALATED:
      patchJob(client, payload?.job)
      break
    case REALTIME_EVENTS.AGENT_MOVED:
      patchPosition(client, payload)
      break
    default:
      break
  }
}

// Single socket lifecycle owner is the app shell (calls this once). The hook
// never disconnects on unmount so concurrent users share the one socket.
// Returns disconnect state for the persistent banner + polling flag:
//   isPolling === true  -> disconnected, consumers refetch PostgreSQL truth
//                          on POLLING_INTERVAL_MS via refetchInterval (T5).
// Reconnect runs exactly one client.invalidateQueries() reconciliation.
export function useRealtime(options = {}) {
  const ambientClient = useQueryClient()
  const client = options.queryClient ?? ambientClient
  const { onReconcile } = options
  const [status, setStatus] = useState(() => getConnectionStatus())

  useEffect(() => subscribeConnectionStatus(setStatus), [])

  useEffect(() => {
    const socket = connectSocket()
    let needsReconcile = false

    const handlers = {
      [REALTIME_EVENTS.JOB_CREATED]: (payload) => patchRealtimeCache(client, REALTIME_EVENTS.JOB_CREATED, payload),
      [REALTIME_EVENTS.JOB_UPDATED]: (payload) => patchRealtimeCache(client, REALTIME_EVENTS.JOB_UPDATED, payload),
      [REALTIME_EVENTS.JOB_ESCALATED]: (payload) =>
        patchRealtimeCache(client, REALTIME_EVENTS.JOB_ESCALATED, payload),
      [REALTIME_EVENTS.AGENT_MOVED]: (payload) => patchRealtimeCache(client, REALTIME_EVENTS.AGENT_MOVED, payload),
    }
    for (const [event, handler] of Object.entries(handlers)) {
      socket.on(event, handler)
    }

    const handleConnect = () => {
      if (needsReconcile) {
        needsReconcile = false
        if (onReconcile) {
          onReconcile()
        } else {
          client.invalidateQueries()
        }
      }
    }
    const handleDisconnect = () => {
      needsReconcile = true
    }
    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)

    return () => {
      for (const [event, handler] of Object.entries(handlers)) {
        socket.off(event, handler)
      }
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
    }
  }, [client, onReconcile])

  const isConnected = status === CONNECTION_STATUS.CONNECTED
  return {
    status,
    isConnected,
    isDisconnected: !isConnected,
    // Polling flag: while disconnected the app refetches PG truth every 15s.
    isPolling: !isConnected,
    pollingIntervalMs: POLLING_INTERVAL_MS,
  }
}
