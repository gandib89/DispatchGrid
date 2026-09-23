import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import App from '../App.jsx'
import { getAccessToken, setAccessToken } from '../lib/api-client.js'
import { mockAccessToken, mockCredentials } from '../mocks/handlers.js'
import { server } from '../mocks/setup.js'
import { renderWithProviders } from '../test/render.jsx'

// A successful register stores its refresh cookie in MSW's cookie store,
// which persists across tests in this file. Force every test to start
// anonymous: only the form's own submit may authenticate.
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

async function fillAccount(user, email, password) {
  await user.type(screen.getByLabelText('Email'), email)
  await user.type(screen.getByLabelText(/^Password/), password)
}

describe('RegisterPage', () => {
  it('registers through the api client, lands the session, and routes into the protected shell', async () => {
    setAccessToken(null)
    const user = userEvent.setup()
    renderWithProviders(<App />, { route: '/register' })
    await screen.findByRole('heading', { name: 'Create your account' })

    await fillAccount(user, 'new@example.com', 'password123')
    await user.type(screen.getByLabelText(/^Display name/), 'Nia Operator')
    await user.type(screen.getByLabelText(/^Organization name/), 'Acme Field')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByText('new@example.com')).toBeInTheDocument()
    expect(getAccessToken()).toBe(mockAccessToken)
    expect(
      screen.queryByRole('heading', { name: 'Create your account' }),
    ).not.toBeInTheDocument()
  })

  it('shows the email_taken envelope message with a usable, focused form', async () => {
    setAccessToken(null)
    const user = userEvent.setup()
    renderWithProviders(<App />, { route: '/register' })
    await screen.findByRole('heading', { name: 'Create your account' })

    await fillAccount(user, mockCredentials.email, 'password123')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Email already registered')
    expect(screen.getByLabelText('Email')).toHaveValue(mockCredentials.email)
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled()
    expect(screen.getByLabelText('Email')).toHaveFocus()
  })

  it('renders validation_error field details from the envelope', async () => {
    setAccessToken(null)
    server.use(
      http.post('*/api/v1/auth/register', () =>
        HttpResponse.json(
          {
            error: {
              code: 'validation_error',
              message: 'Registration details are invalid',
              details: { password: 'Use at least 8 characters' },
            },
          },
          { status: 400 },
        ),
      ),
    )
    const user = userEvent.setup()
    renderWithProviders(<App />, { route: '/register' })
    await screen.findByRole('heading', { name: 'Create your account' })

    await fillAccount(user, 'new@example.com', 'short')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Registration details are invalid')
    expect(await screen.findByText('Use at least 8 characters')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled()
  })
})
