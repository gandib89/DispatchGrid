import { useCallback, useEffect, useRef, useState } from 'react'
import { ToastContext } from './toast-context.js'

const DEFAULT_DURATION_MS = 6000

let nextToastId = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const timersRef = useRef(new Map())

  const dismiss = useCallback((id) => {
    clearTimeout(timersRef.current.get(id))
    timersRef.current.delete(id)
    setToasts((list) => list.filter((toast) => toast.id !== id))
  }, [])

  const toast = useCallback(
    (message, { variant = 'success', duration = DEFAULT_DURATION_MS } = {}) => {
      nextToastId += 1
      const id = nextToastId
      setToasts((list) => [...list, { id, message, variant }])
      if (duration > 0) {
        timersRef.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        )
      }
      return id
    },
    [dismiss],
  )

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
    }
  }, [])

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        aria-label="Notifications"
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
      >
        {toasts.map((entry) => (
          <div
            key={entry.id}
            className={`pointer-events-auto flex items-start justify-between gap-3 rounded-toast border bg-surface px-4 py-3 text-sm shadow-lg ${
              entry.variant === 'error'
                ? 'border-danger/40 text-danger'
                : 'border-success/40 text-success'
            }`}
          >
            <span>{entry.message}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(entry.id)}
              className="text-muted transition hover:text-primary"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
