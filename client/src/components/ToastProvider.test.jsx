import { act, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '../test/render.jsx'
import { useToast } from './toast-context.js'

function ToastButtons() {
  const { toast } = useToast()

  return (
    <div>
      <button type="button" onClick={() => toast('Job saved')}>
        Save
      </button>
      <button type="button" onClick={() => toast('Could not save job', { variant: 'error' })}>
        Fail
      </button>
    </div>
  )
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ToastProvider', () => {
  it('announces a success toast in an aria-live region', async () => {
    const user = userEvent.setup()

    renderWithProviders(<ToastButtons />)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Job saved')).toBeInTheDocument()
    const region = screen.getByLabelText('Notifications')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toContainElement(screen.getByText('Job saved'))
  })

  it('renders an error toast and removes it when dismissed', async () => {
    const user = userEvent.setup()

    renderWithProviders(<ToastButtons />)
    await user.click(screen.getByRole('button', { name: 'Fail' }))

    expect(await screen.findByText('Could not save job')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Could not save job')).not.toBeInTheDocument()
  })

  it('auto-dismisses a toast after its duration', () => {
    vi.useFakeTimers()

    renderWithProviders(<ToastButtons />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('Job saved')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(screen.queryByText('Job saved')).not.toBeInTheDocument()
  })
})
