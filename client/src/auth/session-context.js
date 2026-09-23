import { createContext, useContext } from 'react'

export const SessionContext = createContext(null)

export function useSession() {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession must be used within SessionProvider')
  return session
}
