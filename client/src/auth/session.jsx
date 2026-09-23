import { useCallback, useEffect, useRef, useState } from 'react'
import { apiRequest, setAccessToken } from '../lib/api-client.js'
import { setOrganizationId } from '../lib/socket-client.js'
import { SessionContext } from './session-context.js'

const ANONYMOUS = { user: null, organizationId: null, roleName: null }

export function SessionProvider({ children }) {
  const [state, setState] = useState({ status: 'restoring', ...ANONYMOUS })

  const clearSession = useCallback(() => {
    setAccessToken(null)
    setOrganizationId(null)
    setState({ status: 'anonymous', ...ANONYMOUS })
  }, [])

  // Org/role enrichment is best-effort: the session stands without it.
  const enrich = useCallback(async (user) => {
    let organizationId = null
    let roleName = null
    try {
      const { organizations } = await apiRequest('/api/v1/organizations')
      // Organization context is known only for a single membership.
      // Multi-org users stay null: the server returns 400
      // selection-required (details.header x-organization-id) on tenant
      // routes until an org picker supplies the hint.
      if (organizations.length === 1) {
        organizationId = organizations[0].id
        setOrganizationId(organizationId)
        const { members } = await apiRequest(`/api/v1/organizations/${organizationId}/members`)
        roleName = members.find((member) => member.userId === user.id)?.roleName ?? null
      }
    } catch {
      // Best-effort only.
    }
    return { organizationId, roleName }
  }, [])

  const restore = useCallback(async () => {
    try {
      // /auth/me returns a bare {id,email}; apiRequest owns the
      // 401 -> single-flight refresh -> replay path, so a lost in-memory
      // token is renewed here and a failed refresh surfaces as a 401.
      const user = await apiRequest('/api/v1/auth/me')
      const { organizationId, roleName } = await enrich(user)
      setState({ status: 'authenticated', user, organizationId, roleName })
    } catch {
      // Refresh failure (or unreachable auth) during restore clears the
      // session and the single in-memory token.
      clearSession()
    }
  }, [clearSession, enrich])

  // Entry screens land the session through the same api client: token into
  // memory, org/role enrichment, then the authenticated state.
  const establish = useCallback(
    async (path, body) => {
      const { user, accessToken } = await apiRequest(path, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setAccessToken(accessToken)
      const { organizationId, roleName } = await enrich(user)
      setState({ status: 'authenticated', user, organizationId, roleName })
    },
    [enrich],
  )

  const login = useCallback((credentials) => establish('/api/v1/auth/login', credentials), [establish])
  const register = useCallback((payload) => establish('/api/v1/auth/register', payload), [establish])

  // StrictMode double-effect guard: one restore per provider instance.
  const restoreStartedRef = useRef(false)
  useEffect(() => {
    if (restoreStartedRef.current) return
    restoreStartedRef.current = true
    void restore()
  }, [restore])

  const logout = useCallback(async () => {
    try {
      await apiRequest('/api/v1/auth/logout', { method: 'POST' })
    } catch {
      // Local session clears regardless of the server outcome.
    }
    clearSession()
  }, [clearSession])

  const value = {
    status: state.status,
    user: state.user,
    organizationId: state.organizationId,
    roleName: state.roleName,
    isAuthenticated: state.status === 'authenticated',
    login,
    register,
    logout,
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
