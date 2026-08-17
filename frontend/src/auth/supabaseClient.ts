/**
 * The one Supabase client, and the one place a token comes from.
 *
 * Email + password only. No OAuth provider, no magic link, no anonymous
 * sign-in — Supabase is here to be an identity provider and nothing else. The
 * play, the characters, the rehearsal history and the beat scores all still
 * live in CockroachDB behind our own API; this holds only "who is she".
 *
 * The session (access token + refresh token) is stored in localStorage by the
 * client and refreshed in the background. That is deliberately *not* a cookie:
 * the frontend is on Amplify and the API is on ECS, unrelated domains, so a
 * shared cookie between them would be a third-party cookie — `SameSite=None;
 * Secure` and blocked outright by Safari's ITP. The token travels in an
 * `Authorization` header instead, which has no origin rules to fall foul of.
 *
 * The trade that comes with it: a token in localStorage is readable by any
 * script running on this origin, where an httpOnly cookie was not. That is the
 * standard bearer-token trade, and it is worth taking here because the
 * alternative was an auth that does not work at all on one of the two browsers
 * an actor is likely to be holding.
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY

// Failing loudly at load rather than at the first sign-in attempt. Vite inlines
// these at build time, so a missing one is a *build environment* problem — an
// Amplify environment variable nobody set — and it would otherwise surface as
// "Save Progress does nothing", days later, on the deployed site only.
//
// Note for local dev: Vite reads `frontend/.env` and nothing else. The API's
// SUPABASE_URL lives in `api/.env` — one .env per runtime, no repo-root file —
// so these are two separate entries that must name the same project.
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_KEY. Copy frontend/.env.example to frontend/.env and fill them in.',
  )
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    // On by default, and named here because everything downstream depends on
    // it: `getAccessToken` below hands out whatever the client currently holds,
    // and a token is only reliably fresh because this is quietly renewing it.
    autoRefreshToken: true,
    // Nothing in this app signs in through a redirect, so there is never a
    // token in the URL to detect — and leaving this on makes the client parse
    // every page load's hash looking for one.
    detectSessionInUrl: false,
  },
})

/**
 * The access token to send to our API, or null for a guest.
 *
 * `getSession()` rather than a token cached in React state: it returns the
 * stored session and refreshes it first if it has expired, so a call made after
 * a laptop has been shut for two hours still goes out with a valid token
 * instead of a 401. Every request pays a cheap local read for that; only an
 * actually-expired token costs a round trip.
 */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}
