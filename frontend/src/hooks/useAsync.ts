import { useEffect, useState } from 'react'
import type { DependencyList } from 'react'

interface AsyncState<T> {
  data: T | undefined
  loading: boolean
  error: unknown
}

/**
 * Wraps a stub (and later, real) data-client call in the loading/error shape every page needs.
 * `fn` is expected to be a fresh closure per render; only `deps` controls when it re-runs.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: undefined, loading: true, error: undefined })

  useEffect(() => {
    let cancelled = false
    setState({ data: undefined, loading: true, error: undefined })

    fn()
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: undefined })
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ data: undefined, loading: false, error })
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-provided deps intentionally control re-fetching, not `fn` identity
  }, deps)

  return state
}
