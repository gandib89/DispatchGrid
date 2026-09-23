import { useRealtime } from '../hooks/use-realtime.js'

// Single socket lifecycle owner (B15-T4 #47): this component calls
// useRealtime once per page; pages consume cache, never sockets.
export function AppShell({ children }) {
  const { isDisconnected, pollingIntervalMs } = useRealtime()

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {isDisconnected ? (
        <div
          role="alert"
          className="border-b border-amber-300/20 bg-amber-300/10 px-6 py-2 text-center text-xs font-medium text-amber-200"
        >
          Realtime disconnected — refreshing from the server every {pollingIntervalMs / 1000}s.
        </div>
      ) : null}
      <header className="border-b border-white/10">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <p className="text-lg font-semibold tracking-tight">DispatchGrid</p>
        </div>
      </header>
      <main>{children}</main>
    </div>
  )
}
