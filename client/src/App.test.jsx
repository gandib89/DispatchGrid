import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import App from './App.jsx'
import { setAccessToken } from './lib/api-client.js'
import { setOrganizationId } from './lib/socket-client.js'
import { mockAccessToken, mockUser } from './mocks/handlers.js'
import { renderWithProviders } from './test/render.jsx'

afterEach(() => {
  cleanup()
  setAccessToken(null)
  setOrganizationId(null)
})

describe('App routing', () => {
  it('redirects unauthenticated visitors on protected routes to /login', async () => {
    setAccessToken(null)
    renderWithProviders(<App />, { route: '/' })

    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument()
    expect(screen.queryByText(/foundation is ready/i)).not.toBeInTheDocument()
  })

  it('keeps public routes reachable without a session', async () => {
    setAccessToken(null)
    renderWithProviders(<App />, { route: '/register' })

    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument()
  })

  it('serves the protected home once the session restores', async () => {
    setAccessToken(mockAccessToken)
    renderWithProviders(<App />, { route: '/' })

    expect(await screen.findByText(mockUser.email)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument()
  })

  it('routes unknown paths through the route table instead of a demo catch-all', async () => {
    setAccessToken(null)
    renderWithProviders(<App />, { route: '/no-such-page' })

    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument()
  })
})
