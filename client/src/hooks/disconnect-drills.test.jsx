import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('socket.io-client', () => ({ io: vi.fn() }))

import { apiRequest } from '../lib/api-client.js'
import { REALTIME_EVENTS, disconnectSocket } from '../lib/socket-client.js'
import { io } from 'socket.io-client'
import { queryClient as appQueryClient } from '../query-client.js'
import { POLLING_INTERVAL_MS, patchRealtimeCache, useRealtime } from './use-realtime.js'

// B15-T5 (#48) disconnect drills in the T4 harness (mocked io, fake socket,
// stubbed fetch as PostgreSQL truth): the socket-drop drill proves the banner
// state, the polling cadence keeping data updating off PG truth, and the
// exactly-once reconnect reconciliation; the missed-events drill proves a
// whole dark window resolves after that single refresh; the movement drill
// drives patchRealtimeCache directly and proves a burst stays fetch-free.
//
// The cadence mechanism runs on a fast interval prop under real timers
// (TanStack observer notifications do not re-render under fake timers); the
// 15s value itself is asserted as a constant equal to the query-client
// staleTime, the T4 precedent. Job-correctness rides along: every rendered
// board state is asserted exact against the stubbed PG truth.

function createFakeSocket() {
  const handlers = new Map()
  return {
    connected: false,
    on: vi.fn((event, fn) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn])
    }),
    off: vi.fn((event, fn) => {
      handlers.set(event, (handlers.get(event) ?? []).filter((item) => item !== fn))
    }),
    removeAllListeners: vi.fn(() => handlers.clear()),
    disconnect: vi.fn(),
    connect: vi.fn(),
    emitLocal(event, payload) {
      for (const fn of [...(handlers.get(event) ?? [])]) {
        fn(payload)
      }
    },
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function testClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

// The consumer contract B18 builds on: while the polling flag reads, the
// board refetches PostgreSQL truth on the interval; while connected, events
// patch the cache and no interval runs. intervalMs is injectable for drill
// speed — production passes the POLLING_INTERVAL_MS default.
function Board({ client, intervalMs = POLLING_INTERVAL_MS }) {
  const { isDisconnected } = useRealtime({ queryClient: client })
  const board = useQuery({
    queryKey: ['jobs'],
    queryFn: () => apiRequest('/api/v1/jobs'),
    refetchInterval: isDisconnected ? intervalMs : false,
  })
  return (
    <>
      {isDisconnected ? <div role="alert">polling every {intervalMs / 1000}s</div> : null}
      <div data-testid="board">
        {board.data ? board.data.jobs.map((job) => `${job.id}:${job.status}`).join(',') : 'loading'}
      </div>
    </>
  )
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function emit(event, payload) {
  act(() => {
    fake.emitLocal(event, payload)
  })
}

let fake

beforeEach(() => {
  vi.clearAllMocks()
  fake = createFakeSocket()
  io.mockReturnValue(fake)
})

afterEach(() => {
  disconnectSocket()
  cleanup()
  vi.unstubAllGlobals()
})

describe('disconnect drills', () => {
  it('polling cadence is 15s, matching the query-client staleTime', () => {
    expect(POLLING_INTERVAL_MS).toBe(15_000)
    expect(POLLING_INTERVAL_MS).toBe(appQueryClient.getDefaultOptions().queries.staleTime)
  })

  it('socket-drop: banner state, polling keeps data updating, reconnect reconciles exactly once', async () => {
    let pgTruth = [{ id: 'job-1', status: 'PENDING' }]
    const fetch = vi.fn(async () => jsonResponse({ jobs: pgTruth }))
    vi.stubGlobal('fetch', fetch)
    const client = testClient()

    render(
      <QueryClientProvider client={client}>
        <Board client={client} intervalMs={100} />
      </QueryClientProvider>,
    )

    // Mount fetches once; the singleton starts disconnected so the banner and
    // the polling flag read at once.
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('board')).toHaveTextContent('job-1:PENDING'))
    expect(screen.getByRole('alert')).toBeInTheDocument()

    // Connect: banner clears, polling stops — a quiet window costs nothing.
    emit('connect', undefined)
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    await sleep(300)
    expect(fetch).toHaveBeenCalledTimes(1)

    // Drop: banner back, and PostgreSQL moves on while we are dark.
    emit('disconnect', undefined)
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    pgTruth = [
      { id: 'job-1', status: 'ASSIGNED' },
      { id: 'job-2', status: 'PENDING' },
    ]

    // Polling keeps data updating off PG truth — no socket needed.
    await waitFor(
      () => expect(screen.getByTestId('board')).toHaveTextContent('job-1:ASSIGNED,job-2:PENDING'),
      { timeout: 2000 },
    )
    const darkFetches = fetch.mock.calls.length
    expect(darkFetches).toBeGreaterThan(1)

    // Reconnect: exactly one reconciliation refresh, then silence — no storm.
    emit('connect', undefined)
    await waitFor(() => expect(fetch.mock.calls.length).toBe(darkFetches + 1), { timeout: 2000 })
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    await sleep(300)
    expect(fetch.mock.calls.length).toBe(darkFetches + 1)
  })

  it('missed events: a whole dark window resolves after the single reconnect refresh', async () => {
    let pgTruth = [{ id: 'job-1', status: 'PENDING', title: 'Pump' }]
    const fetch = vi.fn(async () => jsonResponse({ jobs: pgTruth }))
    vi.stubGlobal('fetch', fetch)
    const client = testClient()

    render(
      <QueryClientProvider client={client}>
        <Board client={client} intervalMs={60_000} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))

    // Live session, then the drop. Push has no backlog — everything below is
    // missed and must resolve through the one refresh (the 60s interval can
    // never fire inside this fast drill, so any refresh is the reconcile).
    emit('connect', undefined)
    emit('disconnect', undefined)
    pgTruth = [
      { id: 'job-1', status: 'CANCELLED', title: 'Pump urgently' },
      { id: 'job-2', status: 'ASSIGNED', title: 'Valve' },
      { id: 'job-3', status: 'PENDING', title: 'Meter' },
    ]

    const before = fetch.mock.calls.length
    emit('connect', undefined)
    await waitFor(() => expect(fetch.mock.calls.length).toBe(before + 1), { timeout: 2000 })
    await waitFor(
      () =>
        expect(screen.getByTestId('board')).toHaveTextContent(
          'job-1:CANCELLED,job-2:ASSIGNED,job-3:PENDING',
        ),
      { timeout: 2000 },
    )
    await sleep(200)
    expect(fetch.mock.calls.length).toBe(before + 1)
  })

  it('movement: a burst of agent.moved patches the cache with zero REST fetches', () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ status: 'ok' }))
    vi.stubGlobal('fetch', fetch)
    const client = testClient()
    client.setQueryData(['positions'], {
      'agent-1': { agentId: 'agent-1', latitude: 51.5, longitude: -0.12 },
    })
    client.setQueryData(['positions', 'agent-1'], {
      agentId: 'agent-1',
      latitude: 51.5,
      longitude: -0.12,
    })

    for (let index = 0; index < 20; index += 1) {
      patchRealtimeCache(client, REALTIME_EVENTS.AGENT_MOVED, {
        agentId: 'agent-1',
        latitude: 51.5 + index * 0.001,
        longitude: -0.12 + index * 0.001,
        recordedAt: new Date(Date.now() + index * 1000).toISOString(),
      })
    }

    expect(fetch).not.toHaveBeenCalled()
    const single = client.getQueryData(['positions', 'agent-1'])
    const fleet = client.getQueryData(['positions'])['agent-1']
    for (const position of [single, fleet]) {
      expect(position.agentId).toBe('agent-1')
      expect(position.latitude).toBeCloseTo(51.5 + 19 * 0.001, 10)
      expect(position.longitude).toBeCloseTo(-0.12 + 19 * 0.001, 10)
    }
    expect(single.recordedAt).toBeDefined()
  })
})
