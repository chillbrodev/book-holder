export const STUB_LATENCY_MS = 250

/**
 * Every stub API call resolves through this instead of synchronously, so pages build real
 * loading states now rather than retrofitting them once a real (also-latent) API exists.
 */
export function delay<T>(value: T, ms: number = STUB_LATENCY_MS): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms)
  })
}
