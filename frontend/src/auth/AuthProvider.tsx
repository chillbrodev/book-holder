import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  type AuthUser,
  getCurrentUser,
  login as apiLogin,
  logout as apiLogout,
  register as apiRegister,
} from './authClient'
import { AuthContext } from './AuthContext'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isCheckingSession, setIsCheckingSession] = useState(true)

  useEffect(() => {
    let cancelled = false

    getCurrentUser()
      .then((current) => {
        if (!cancelled) setUser(current)
      })
      .catch((err: unknown) => {
        // Network/API-unreachable, not "no session" (getCurrentUser already
        // treats a 401 as null) — fail open to guest rather than break the app.
        console.warn('Could not check for an existing session', err)
        if (!cancelled) setUser(null)
      })
      .finally(() => {
        if (!cancelled) setIsCheckingSession(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const register = useCallback(async (username: string, pin: string) => {
    setUser(await apiRegister({ username, pin }))
  }, [])

  const login = useCallback(async (username: string, pin: string) => {
    setUser(await apiLogin({ username, pin }))
  }, [])

  const logout = useCallback(async () => {
    await apiLogout()
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, isCheckingSession, register, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
