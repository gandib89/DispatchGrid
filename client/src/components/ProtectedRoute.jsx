import { Navigate, Outlet } from 'react-router-dom'
import { useSession } from '../auth/session-context.js'

export function ProtectedRoute() {
  const { status, isAuthenticated } = useSession()
  if (status === 'restoring') return null
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <Outlet />
}
