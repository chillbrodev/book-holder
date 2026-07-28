export interface AsyncStatusProps {
  loading: boolean
  error: unknown
}

/** Shared loading/error rendering for every useAsync-backed page — useAsync already tracks
 * `error`, but until now nothing read it, so a failed fetch left pages stuck showing
 * "Loading…" forever instead of surfacing that something went wrong. */
export function AsyncStatus({ loading, error }: AsyncStatusProps) {
  if (loading) {
    return <p className="bh-label">Loading…</p>
  }
  if (error) {
    return <p className="bh-label">Something went wrong loading this page. Try refreshing.</p>
  }
  return null
}
