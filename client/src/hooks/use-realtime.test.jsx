import { useQuery } from '@tanstack/react-query'
import { screen, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('socket.io-client', () => ({ io: vi.fn() }))

import { AppShell } from '../components/AppShell.jsx'
import { apiRequest } from '../lib/api-client.js'
import { REALTIME_EVENTS, disconnectSocket, getConnectionStatus } from '../lib/socket-client.js'
import { queryClient as appQueryClient } from '../query-client.js'
import { createTestQueryClient, renderWithProviders } from '../test/render.jsx'
import { POLLING_INTERVAL_MS, useRealtime } from './use-realtime.js'
import { io } from 'socket.io-client'

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

const oldJob = { id: 'job-1', status: 'open', version: 1, title: 'Old title' }
const updatedJob = { id: 'job-1', status: 'assigned', version: 2, title: 'Old title' }

function Probe({ client, onState }) {
  const state = useRealtime({ queryClient: client })
  onState?.(state)
  return <div data-testid="polling">{String(state.isPolling)}</div>
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  disconnectSocket()
  vi.restoreAllMocks()
})

describe('useRealtime', () => {
  it('patches board, detail, and positions in place with zero fetches', async () => {
    const fake = createFakeSocket()
    io.mockReturnValue(fake)
    const fetch = vi.spyOn(globalThis, 'fetch')
    const client = createTestQueryClient()
    client.setQueryData(['jobs'], [oldJob])
    client.setQueryData(['job', 'job-1'], oldJob)
    client.setQueryData(['positions'], { 'agent-1': { agentId: 'agent-1', latitude: 1, longitude: 1 } })
    client.setQueryData(['positions', 'agent-1'], { agentId: 'agent-1', latitude: 1, longitude: 1 })

    renderWithProviders(<Probe client={client} />, { queryClient: client })
    act(() => {
      fake.emitLocal('connect', undefined)
    })
    expect(screen.getByTestId('polling')).toHaveTextContent('false')

    act(() => {
      fake.emitLocal(REALTIME_EVENTS.JOB_UPDATED, {
        job: updatedJob,
        from: 'open',
        to: 'assigned',
        actor: { userId: 'dispatcher-1' },
      })
    })
    expect(client.getQueryData(['jobs'])).toEqual([updatedJob])
    expect(client.getQueryData(['job', 'job-1'])).toEqual(updatedJob)

    act(() => {
      fake.emitLocal(REALTIME_EVENTS.JOB_CREATED, { job: { id: 'job-2', status: 'open', version: 1 } })
    })
    expect(client.getQueryData(['jobs'])).toEqual([{ id: 'job-2', status: 'open', version: 1 }, updatedJob])

    // Movement burst: five events, still zero REST traffic.
    act(() => {
      for (let index = 0; index < 5; index += 1) {
        fake.emitLocal(REALTIME_EVENTS.AGENT_MOVED, {
          agentId: 'agent-1',
          latitude: 10 + index,
          longitude: 20 + index,
          recordedAt: new Date().toISOString(),
        })
      }
    })
    expect(client.getQueryData(['positions', 'agent-1'])).toMatchObject({ latitude: 14, longitude: 24 })
    expect(client.getQueryData(['positions'])['agent-1']).toMatchObject({ latitude: 14, longitude: 24 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('exposes the polling flag and banner on drop', () => {
    const fake = createFakeSocket()
    io.mockReturnValue(fake)

    renderWithProviders(
      <AppShell>
        <div>child</div>
      </AppShell>,
    )

    // Singleton starts disconnected, so the persistent banner shows at once.
    expect(getConnectionStatus()).toBe('disconnected')
    expect(screen.getByRole('alert')).toHaveTextContent(/every 15s/)
    expect(POLLING_INTERVAL_MS).toBe(15_000)
    expect(POLLING_INTERVAL_MS).toBe(appQueryClient.getDefaultOptions().queries.staleTime)

    act(() => {
      fake.emitLocal('connect', undefined)
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    act(() => {
      fake.emitLocal('disconnect', undefined)
    })
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('reconciles exactly once on reconnect', async () => {
    const fake = createFakeSocket()
    io.mockReturnValue(fake)
    const fetch = vi.spyOn(globalThis, 'fetch')
    const client = createTestQueryClient()

    function Board() {
      const board = useQuery({ queryKey: ['jobs'], queryFn: () => apiRequest('/api/v1/jobs') })
      useRealtime({ queryClient: client })
      return <div data-testid="board">{board.data ? 'loaded' : 'loading'}</div>
    }

    renderWithProviders(<Board />, { queryClient: client })

    await waitFor(() => expect(screen.getByTestId('board')).toHaveTextContent('loaded'))
    expect(fetch).toHaveBeenCalledTimes(1)

    act(() => {
      fake.emitLocal('connect', undefined)
      fake.emitLocal('disconnect', undefined)
      fake.emitLocal('connect', undefined)
    })

    // Exactly one reconciliation refresh for the missed window — not a storm.
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('shares a single in-flight reconcile across hook instances', async () => {
    const fake = createFakeSocket()
    io.mockReturnValue(fake)
    const client = createTestQueryClient()
    const onReconcile = vi.fn()

    function TwoOwners() {
      useRealtime({ queryClient: client, onReconcile })
      useRealtime({ queryClient: client, onReconcile })
      return null
    }

    renderWithProviders(<TwoOwners />, { queryClient: client })

    act(() => {
      fake.emitLocal('disconnect', undefined)
      fake.emitLocal('connect', undefined)
    })

    // One reconnect, one shared reconcile — not one per hook instance.
    await waitFor(() => expect(onReconcile).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(onReconcile).toHaveBeenCalledTimes(1)

    // The guard clears after settling: the next reconnect reconciles again.
    act(() => {
      fake.emitLocal('disconnect', undefined)
      fake.emitLocal('connect', undefined)
    })
    await waitFor(() => expect(onReconcile).toHaveBeenCalledTimes(2))
  })
})
