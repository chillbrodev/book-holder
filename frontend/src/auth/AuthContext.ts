import { createContext } from 'react'
import type { AuthUser } from './authClient'

export interface AuthContextValue {
  user: AuthUser | null
  /** True only while Supabase is reading its stored session on load, so the
   * header can avoid flashing "Save Progress" for a beat at someone who is
   * signed in. Unlike the old `/auth/me` round trip this is a localStorage
   * read, so it is over in a frame — but it is still not synchronous, and the
   * flash it prevents is the same one. */
  isCheckingSession: boolean
  /** Resolves `{ signedIn: false }` when the account was created but Supabase
   * is waiting on an email confirmation. The modal has to say so rather than
   * close on someone who is still a guest. */
  register: (email: string, password: string) => Promise<{ signedIn: boolean }>
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined)
