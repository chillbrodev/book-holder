import { createContext } from 'react'
import type { AuthUser } from './authClient'

export interface AuthContextValue {
  user: AuthUser | null
  /** True only during the initial /auth/me check on load, lets the header avoid
   * flashing "Save Progress" for a beat before a real session is confirmed. */
  isCheckingSession: boolean
  register: (username: string, pin: string) => Promise<void>
  login: (username: string, pin: string) => Promise<void>
  logout: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined)
