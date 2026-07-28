/**
 * Real fetch client for api's play/character/scene/line/polly endpoints —
 * same request shape as auth/authClient.ts (credentials: 'include', typed
 * errors) since both hit the same api origin/session, kept as a separate
 * small helper rather than sharing code so auth's already-working client
 * doesn't need touching.
 */

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
    throw new ApiError(errBody?.error?.name ?? 'UNKNOWN_ERROR', errBody?.error?.msg ?? res.statusText, res.status)
  }

  return body as T
}
