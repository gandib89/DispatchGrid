import { Navigate, Route, Routes } from 'react-router-dom'
import { SessionProvider } from './auth/session.jsx'
import { useSession } from './auth/session-context.js'
import { AppShell } from './components/AppShell.jsx'
import { ProtectedRoute } from './components/ProtectedRoute.jsx'
import { LoginPage } from './pages/LoginPage.jsx'
import { RegisterPage } from './pages/RegisterPage.jsx'

function HomePage() {
  const { user, logout } = useSession()
  return (
    <AppShell>
      <section className="mx-auto max-w-6xl px-6 py-10">
        <p className="text-sm text-slate-400">{user.email}</p>
        <button
          type="button"
          onClick={logout}
          className="mt-4 rounded-lg border border-white/10 px-3 py-1.5 text-sm font-medium text-slate-300 transition hover:border-white/20 hover:bg-white/5"
        >
          Log out
        </button>
      </section>
    </AppShell>
  )
}

function App() {
  return (
    <SessionProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/" element={<HomePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SessionProvider>
  )
}

export default App
