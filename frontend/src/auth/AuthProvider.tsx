import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  type AuthUser,
  login as apiLogin,
  logout as apiLogout,
  register as apiRegister,
  toAuthUser,
} from './authClient'
import { supabase } from './supabaseClient'
import { AuthContext } from './AuthContext'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isCheckingSession, setIsCheckingSession] = useState(true)

  useEffect(() => {
    let cancelled = false

    // Two things, and both are needed.
    //
    // `getSession()` answers "is she signed in right now", which the header
    // needs on the very first render. `onAuthStateChange` keeps that answer
    // true afterwards: a sign-in, a sign-out, a background token refresh, and —
    // the case that is easy to forget — a sign-out performed in another tab,
    // which fires here through the storage event and would otherwise leave this
    // tab showing her name over a session that no longer exists.
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!cancelled) setUser(data.session ? toAuthUser(data.session.user) : null)
      })
      .catch((err: unknown) => {
        // A corrupt stored session, or storage that is unavailable entirely
        // (Safari private browsing). Fail open to guest rather than break the
        // app: rehearsing has never required an account.
        console.warn('Could not read the stored session', err)
        if (!cancelled) setUser(null)
      })
      .finally(() => {
        if (!cancelled) setIsCheckingSession(false)
      })

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session ? toAuthUser(session.user) : null)
      // A late event arriving before getSession() has settled would otherwise
      // leave the header hidden behind isCheckingSession forever.
      setIsCheckingSession(false)
    })

    return () => {
      cancelled = true
      subscription.subscription.unsubscribe()
    }
  }, [])

  // These three deliberately don't call setUser. Every one of them ends in
  // Supabase emitting an auth state change, and the subscription above is what
  // turns that into React state — one path, so a sign-in through the modal and
  // a token refresh at 3am land the same way. Setting it here as well would be
  // a second source of truth that is right almost always.
  const register = useCallback(
    (email: string, password: string) => apiRegister({ email, password }),
    [],
  )

  const login = useCallback(
    (email: string, password: string) => apiLogin({ email, password }),
    [],
  )

  const logout = useCallback(() => apiLogout(), [])

  return (
    <AuthContext.Provider value={{ user, isCheckingSession, register, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
