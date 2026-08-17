/**
 * Real fetch client for api's play/character/scene/line/polly/session endpoints.
 *
 * Every request carries the Supabase access token as `Authorization: Bearer …`
 * rather than relying on a cookie, which is the whole reason auth moved to
 * Supabase: the frontend (Amplify) and the API (ECS) are unrelated domains, so
 * a session cookie between them was a third-party cookie — `SameSite=None;
 * Secure`, and blocked outright by Safari's ITP. A header has no origin rules.
 *
 * `credentials: 'include'` is gone with it. Sending it now would be worse than
 * pointless: it forces the CORS preflight to demand
 * `Access-Control-Allow-Credentials` for a cookie there is no longer any reason
 * to send.
 */
import { getAccessToken } from '../auth/supabaseClient'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000'

interface ApiErrorBody {
  error: { name: string; msg: string }
}

export class ApiError extends Error {
  readonly name: string
  readonly status: number

  constructor(name: string, message: string, status: number) {
    super(message)
    this.name = name
    this.status = status
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  // Fetched per request rather than held in a module variable, because
  // `getAccessToken` refreshes an expired token before returning it. A cached
  // one goes stale after an hour and every call starts 401ing — which looks
  // like the API is broken rather than like a token that needed renewing.
  //
  // Null for a guest, and that is not an error: /plays, /polly and /capture all
  // work signed out. Only the endpoints that need an owner answer 401, and
  // their callers already treat that as "this run won't be remembered".
  const token = await getAccessToken()

  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })

  if (res.status === 204) {
    return undefined as T
  }

  const body: unknown = await res.json().catch(() => undefined)

  if (!res.ok) {
    const errBody = body as ApiErrorBody | undefined
    throw new ApiError(errBody?.error?.name ?? 'UNKNOWN_ERROR', errBody?.error?.msg ?? res.statusText, res.status)
  }

  return body as T
}
