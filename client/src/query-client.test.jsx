import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRequest } from './lib/api-client.js'
import { queryClient } from './query-client.js'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('query defaults', () => {
  const retry = queryClient.getDefaultOptions().queries.retry

  it('keeps validation, auth, and conflict 4xx errors from being retried', () => {
    expect(retry(0, { status: 400 })).toBe(false)
    expect(retry(1, { status: 401 })).toBe(false)
    expect(retry(0, { status: 409 })).toBe(false)
  })

  it('retries server and network failures at most twice', () => {
    expect(retry(0, { status: 500 })).toBe(true)
    expect(retry(1, { status: 503 })).toBe(true)
    expect(retry(2, { status: 500 })).toBe(false)
    expect(retry(0, new Error('Network Error'))).toBe(true)
  })

  it('never retries mutations', () => {
    expect(queryClient.getDefaultOptions().mutations.retry).toBe(false)
  })

  it('UI seam: a validation error renders once off a single request', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ error: { code: 'validation_error', message: 'Title is required' } }, 400),
    )
    vi.stubGlobal('fetch', fetch)

    function Probe() {
      const query = useQuery({
        queryKey: ['b17-validation-probe'],
        queryFn: () => apiRequest('/api/v1/jobs'),
      })
      if (query.isError) return <div>{query.error.code}</div>
      return <div>{query.status}</div>
    }

    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    )

    expect(await screen.findByText('validation_error')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
