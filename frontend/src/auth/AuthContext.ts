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
  /**
   * Bumped once per sign-out, and never on sign-in.
   *
   * The app keys its route tree on this so that leaving forces every screen to
   * re-fetch as a guest — clearing her stored place does nothing on its own,
   * because the play page's `useAsync` is keyed on the play and would go on
   * showing the card it already has.
   *
   * Not the user id, which would have been the obvious key and is wrong in one
   * important case: signing in happens *during* a rehearsal, since "Save
   * Progress" is offered from the header mid-scene. Remounting on that would
   * throw away the run she is in the middle of, to fix a problem sign-in does
   * not have — her place is still her place.
   */
  resetKey: number
  /** Resolves `{ signedIn: false }` when the account was created but Supabase
   * is waiting on an email confirmation. The modal has to say so rather than
   * close on someone who is still a guest. */
  register: (email: string, password: string) => Promise<{ signedIn: boolean }>
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined)
