export function AppShell({ children }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-white/10">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div>
            <p className="text-lg font-semibold tracking-tight">DispatchGrid</p>
            <p className="text-xs text-slate-400">Field operations, clearly coordinated</p>
          </div>
          <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-300">
            Foundation
          </span>
        </div>
      </header>
      <main>{children}</main>
    </div>
  )
}
