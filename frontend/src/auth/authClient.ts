/**
 * Real fetch client for `api`'s auth endpoints — unlike everything in
 * data/client.ts, this isn't a stub. `api` only has auth wired up so far
 * (see docs/API_PLAN.md); the rehearsal-flow endpoints it documents are
 * still mock/localStorage-backed until those exist server-side.
 *
 * `credentials: 'include'` on every call so the httpOnly session cookie
 * `api` sets is sent/received — the frontend never touches the token
 * itself, only whether a session exists (via /auth/me).
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000'

export interface AuthUser {
  id: string
  username: string
  name: string
}

interface ApiErrorBody {
  error: { name: string; msg: string }
}

/** `name` mirrors api's AuthError name union (VALIDATION_ERROR, INVALID_CREDENTIALS, etc.) —
 * see api/src/features/auth/errors.ts. Not re-declared as a literal union here so this client
 * doesn't need to change every time the API adds an error case. */
export class AuthApiError extends Error {
  readonly name: string
  readonly status: number

  constructor(name: string, message: string, status: number) {
    super(message)
    this.name = name
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...init?.headers },
  })

  if (res.status === 204) {
    return undefined as T
  }

  const body: unknown = await res.json().catch(() => undefined)

  if (!res.ok) {
    const errBody = body as ApiErrorBody | undefined
    throw new AuthApiError(
      errBody?.error?.name ?? 'UNKNOWN_ERROR',
      errBody?.error?.msg ?? res.statusText,
      res.status,
    )
  }

  return body as T
}

export function register(input: { username: string; pin: string }): Promise<AuthUser> {
  // api's schema requires a separate display `name` — this "lightweight" flow only
  // asks for a username + PIN, so name defaults to the username itself.
  return request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: input.username, name: input.username, pin: input.pin }),
  })
}

export function login(input: { username: string; pin: string }): Promise<AuthUser> {
  return request('/auth/login', { method: 'POST', body: JSON.stringify(input) })
}

export function logout(): Promise<void> {
  return request('/auth/logout', { method: 'POST' })
}

/** Resolves to `null` (not a rejection) when there's no valid session — that's the
 * expected steady state for a guest, not an error condition callers need to branch on. */
export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    return await request<AuthUser>('/auth/me')
  } catch (err) {
    if (err instanceof AuthApiError && err.status === 401) return null
    throw err
  }
}
