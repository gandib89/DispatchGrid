import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App.jsx'
import { renderWithProviders } from './test/render.jsx'

describe('App', () => {
  it('shows that the API is connected when health succeeds', async () => {
    renderWithProviders(<App />)

    expect(await screen.findByText('ready', { selector: 'span' })).toBeInTheDocument()
  })
})
