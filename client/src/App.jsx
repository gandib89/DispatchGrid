import { useQuery } from '@tanstack/react-query'
import { Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell.jsx'
import { apiRequest } from './lib/api-client.js'

function FoundationPage() {
  const health = useQuery({
    queryKey: ['api-health'],
    queryFn: () => apiRequest('/healthz'),
    retry: false,
  })

  const apiConnected = health.data?.status === 'ok'

  return (
    <AppShell>
      <section className="mx-auto grid min-h-[calc(100vh-89px)] max-w-6xl items-center gap-12 px-6 py-16 lg:grid-cols-[1.15fr_0.85fr]">
        <div>
          <p className="mb-4 text-sm font-semibold uppercase tracking-[0.2em] text-cyan-300">
            Development environment
          </p>
          <h1 className="max-w-3xl text-5xl font-semibold tracking-[-0.04em] text-white sm:text-6xl">
            The DispatchGrid foundation is ready.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-300">
            React, Express, PostgreSQL, Redis, Prisma, and the worker process now have a clean place
            to grow into the domain components in the build plan.
          </p>
        </div>

        <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-6 shadow-2xl shadow-cyan-950/30 backdrop-blur">
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-base font-semibold text-white">Local services</h2>
            <button
              type="button"
              onClick={() => health.refetch()}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-white/20 hover:bg-white/5"
            >
              Check again
            </button>
          </div>

          <div className="space-y-3">
            <StatusRow label="Frontend" detail="Vite + React" status="ready" />
            <StatusRow
              label="API"
              detail="Express /healthz"
              status={health.isPending ? 'checking' : apiConnected ? 'ready' : 'offline'}
            />
            <StatusRow label="Database" detail="PostgreSQL 16" status="configured" />
            <StatusRow label="Queue and cache" detail="Redis 7" status="configured" />
          </div>

          {health.isError ? (
            <p className="mt-5 rounded-xl border border-amber-300/20 bg-amber-300/10 p-3 text-sm leading-6 text-amber-200">
              Start the API with <code>npm run dev</code> from the server directory.
            </p>
          ) : null}
        </div>
      </section>
    </AppShell>
  )
}

function StatusRow({ label, detail, status }) {
  const statusStyles = {
    ready: 'bg-emerald-400 text-emerald-950',
    checking: 'bg-cyan-300 text-cyan-950',
    configured: 'bg-slate-600 text-slate-100',
    offline: 'bg-amber-300 text-amber-950',
  }

  return (
    <div className="flex items-center justify-between rounded-2xl border border-white/[0.08] bg-slate-950/50 p-4">
      <div>
        <p className="font-medium text-white">{label}</p>
        <p className="mt-0.5 text-sm text-slate-400">{detail}</p>
      </div>
      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${statusStyles[status]}`}>
        {status}
      </span>
    </div>
  )
}

function App() {
  return (
    <Routes>
      <Route path="*" element={<FoundationPage />} />
    </Routes>
  )
}

export default App
