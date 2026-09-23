import { useQuery } from '@tanstack/react-query'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { apiRequest } from '../lib/api-client.js'
import { server } from '../mocks/setup.js'
import { renderWithProviders } from '../test/render.jsx'
import { AsyncState } from './AsyncState.jsx'

function JobsProbe({ queryFn }) {
  const query = useQuery({ queryKey: ['t4-jobs'], queryFn, retry: false })

  return (
    <AsyncState
      loading={query.isPending}
      error={query.error}
      onRetry={() => query.refetch()}
      isEmpty={query.data?.jobs?.length === 0}
      emptyMessage="No jobs yet."
    >
      <ul>
        {query.data?.jobs?.map((job) => (
          <li key={job.id}>{job.title}</li>
        ))}
      </ul>
    </AsyncState>
  )
}

describe('AsyncState', () => {
  it('announces loading while the request is in flight', async () => {
    let resolveQuery
    const pending = new Promise((resolve) => {
      resolveQuery = resolve
    })

    renderWithProviders(<JobsProbe queryFn={() => pending} />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading')

    await act(async () => {
      resolveQuery({ jobs: [{ id: 'job-1', title: 'Pump repair' }] })
      await pending
    })
    expect(await screen.findByText('Pump repair')).toBeInTheDocument()
  })

  it('shows the empty state when the mocked request succeeds with no rows', async () => {
    server.use(http.get('*/api/v1/jobs', () => HttpResponse.json({ jobs: [] })))

    renderWithProviders(<JobsProbe queryFn={() => apiRequest('/api/v1/jobs')} />)

    expect(await screen.findByText('No jobs yet.')).toBeInTheDocument()
  })

  it('surfaces the typed ApiError code/message and recovers through retry', async () => {
    let failNext = true
    server.use(
      http.get('*/api/v1/jobs', () => {
        if (failNext) {
          failNext = false
          return HttpResponse.json(
            { error: { code: 'internal_error', message: 'Dispatcher backend unavailable' } },
            { status: 500 },
          )
        }
        return HttpResponse.json({ jobs: [{ id: 'job-1', title: 'Pump repair' }] })
      }),
    )
    const user = userEvent.setup()

    renderWithProviders(<JobsProbe queryFn={() => apiRequest('/api/v1/jobs')} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('internal_error')
    expect(alert).toHaveTextContent('Dispatcher backend unavailable')

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Pump repair')).toBeInTheDocument()
  })
})
