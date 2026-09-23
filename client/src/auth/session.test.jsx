import { StrictMode } from 'react'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAccessToken, setAccessToken } from '../lib/api-client.js'
import { mockAccessToken, mockOrganization, mockUser } from '../mocks/handlers.js'
import { server } from '../mocks/setup.js'
import { renderWithProviders } from '../test/render.jsx'
import { useSession } from './session-context.js'
import { SessionProvider } from './session.jsx'

function Probe() {
  const { status, user, organizationId, roleName, isAuthenticated, logout } = useSession()
  if (status === 'restoring') return <div>restoring</div>
  if (!isAuthenticated) return <div>anonymous</div>
  return (
    <div>
      <p>{user.email}</p>
      <p>{organizationId}</p>
      <p>{roleName}</p>
      <button type="button" onClick={logout}>
        Log out
      </button>
    </div>
  )
}

function callsTo(fetchSpy, fragment) {
  return fetchSpy.mock.calls.filter(([url]) => String(url).includes(fragment))
}

// cleanup + token/org reset are global in test/setup.js.
afterEach(() => {
  vi.restoreAllMocks()
})

describe('session restore', () => {
  it('restores exactly once under StrictMode and exposes user, organization, and role', async () => {
    setAccessToken(mockAccessToken)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    renderWithProviders(
      <StrictMode>
        <SessionProvider>
          <Probe />
        </SessionProvider>
      </StrictMode>,
    )

    expect(await screen.findByText(mockUser.email)).toBeInTheDocument()
    expect(screen.getByText(mockOrganization.id)).toBeInTheDocument()
    expect(screen.getByText('ADMIN')).toBeInTheDocument()
    expect(callsTo(fetchSpy, '/auth/me')).toHaveLength(1)
  })

  it('restores through the refresh cookie when the in-memory token is gone', async () => {
    setAccessToken(null)
    server.use(
      http.post('*/api/v1/auth/refresh', () =>
        HttpResponse.json({ user: mockUser, accessToken: mockAccessToken }),
      ),
    )
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    renderWithProviders(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    )

    expect(await screen.findByText(mockUser.email)).toBeInTheDocument()
    expect(getAccessToken()).toBe(mockAccessToken)
    expect(callsTo(fetchSpy, '/auth/refresh')).toHaveLength(1)
    expect(callsTo(fetchSpy, '/auth/me').length).toBeGreaterThan(0)
  })

  it('clears the session and token when refresh fails during restore', async () => {
    setAccessToken('stale-token')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    renderWithProviders(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    )

    expect(await screen.findByText('anonymous')).toBeInTheDocument()
    expect(getAccessToken()).toBeNull()
    expect(callsTo(fetchSpy, '/auth/me')).toHaveLength(1)
    expect(callsTo(fetchSpy, '/auth/refresh')).toHaveLength(1)
  })

  it('logout calls the endpoint and clears session and token', async () => {
    setAccessToken(mockAccessToken)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const user = userEvent.setup()

    renderWithProviders(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    )
    await screen.findByText(mockUser.email)

    await user.click(screen.getByRole('button', { name: 'Log out' }))

    expect(await screen.findByText('anonymous')).toBeInTheDocument()
    expect(getAccessToken()).toBeNull()
    expect(callsTo(fetchSpy, '/auth/logout')).toHaveLength(1)
  })
})
