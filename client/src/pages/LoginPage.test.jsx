import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from '../App.jsx'
import { getAccessToken, setAccessToken } from '../lib/api-client.js'
import { setOrganizationId } from '../lib/socket-client.js'
import { mockAccessToken, mockCredentials, mockUser } from '../mocks/handlers.js'
import { server } from '../mocks/setup.js'
import { renderWithProviders } from '../test/render.jsx'

// A successful login stores its refresh cookie in MSW's cookie store, which
// persists across tests in this file. Force every test to start anonymous:
// restore's refresh must fail so only the form's own submit authenticates.
beforeEach(() => {
  server.use(
    http.post('*/api/v1/auth/refresh', () =>
      HttpResponse.json(
        { error: { code: 'unauthorized', message: 'Refresh token missing' } },
        { status: 401 },
      ),
    ),
  )
})

afterEach(() => {
  cleanup()
  setAccessToken(null)
  setOrganizationId(null)
})

async function fillCredentials(user, email, password) {
  await user.type(screen.getByLabelText('Email'), email)
  await user.type(screen.getByLabelText('Password'), password)
}

describe('LoginPage', () => {
  it('submits through the api client, lands the session, and routes into the protected shell', async () => {
    setAccessToken(null)
    const user = userEvent.setup()
    renderWithProviders(<App />, { route: '/login' })
    await screen.findByRole('heading', { name: 'Log in' })

    await fillCredentials(user, mockCredentials.email, mockCredentials.password)
    // Keyboard submission via the form's implicit submit button.
    await user.keyboard('{Enter}')

    expect(await screen.findByText(mockUser.email)).toBeInTheDocument()
    expect(getAccessToken()).toBe(mockAccessToken)
    expect(screen.queryByRole('heading', { name: 'Log in' })).not.toBeInTheDocument()
  })

  it('shows the unauthorized envelope message on bad credentials and keeps the form usable', async () => {
    setAccessToken(null)
    const user = userEvent.setup()
    renderWithProviders(<App />, { route: '/login' })
    await screen.findByRole('heading', { name: 'Log in' })

    await fillCredentials(user, mockCredentials.email, 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Log in' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Invalid email or password')
    expect(screen.getByLabelText('Email')).toHaveValue(mockCredentials.email)
    expect(screen.getByRole('button', { name: 'Log in' })).toBeEnabled()
    expect(screen.getByLabelText('Password')).toHaveFocus()

    await user.clear(screen.getByLabelText('Password'))
    await user.type(screen.getByLabelText('Password'), mockCredentials.password)
    await user.click(screen.getByRole('button', { name: 'Log in' }))

    expect(await screen.findByText(mockUser.email)).toBeInTheDocument()
    expect(getAccessToken()).toBe(mockAccessToken)
  })
})
