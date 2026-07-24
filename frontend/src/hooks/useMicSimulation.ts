import { useEffect, useRef, useState } from 'react'

export type MicState = 'connecting' | 'listening' | 'processing' | 'captured' | 'cantHear'

interface UseMicSimulationResult {
  micState: MicState
  tapMic: () => void
  retry: () => void
  simulateCantHear: () => void
}

const PROCESSING_DELAY_MS = 850

/**
 * Local timer-driven stand-in for the real mic pipeline (Transcribe/WebSocket) — deliberately
 * not a stub API call, since the real thing is a streaming integration, not a REST fetch.
 * `resetKey` (e.g. the active line's id) re-arms the state machine at "connecting" whenever
 * the active line changes.
 */
export function useMicSimulation(resetKey: string): UseMicSimulationResult {
  const [micState, setMicState] = useState<MicState>('connecting')
  const timers = useRef<number[]>([])

  useEffect(() => {
    setMicState('connecting')
    const activeTimers = timers.current
    return () => {
      activeTimers.forEach((timer) => window.clearTimeout(timer))
      activeTimers.length = 0
    }
  }, [resetKey])

  function tapMic(): void {
    if (micState === 'connecting') {
      setMicState('listening')
      return
    }
    if (micState === 'listening') {
      setMicState('processing')
      const timer = window.setTimeout(() => setMicState('captured'), PROCESSING_DELAY_MS)
      timers.current.push(timer)
    }
  }

  function retry(): void {
    setMicState('connecting')
  }

  function simulateCantHear(): void {
    setMicState('cantHear')
  }

  return { micState, tapMic, retry, simulateCantHear }
}
