import { useCallback, useEffect, useRef, useState } from 'react'
import { openCaptureSocket, type CaptureEvent, type CaptureSocket } from '../data/captureClient'

/**
 * The real mic pipeline, replacing `useMicSimulation`'s timers: getUserMedia →
 * AudioWorklet → 16 kHz PCM → WebSocket → Amazon Transcribe, with beat progress
 * coming back the other way.
 *
 * Keyed on the **block**, not the beat. The mic stays open across a whole speech
 * and she delivers it at natural pace; beats are scoring boundaries, not
 * interaction boundaries, so nothing here stops and restarts at a beat edge
 * (docs/OPEN_ITEMS.md §1b). `beatIndex` is what moves during a block — the
 * connection doesn't.
 */

export type MicState = 'connecting' | 'listening' | 'processing' | 'captured' | 'cantHear'

/** Transcribe's recommended rate for speech, and what the server tells Transcribe
 * to expect (api's transcribeClient.ts). The two must agree: a mismatch is not an
 * error anywhere, just a transcript of pitched-up nonsense. */
const TARGET_SAMPLE_RATE = 16000

/** Audio per WebSocket frame. Transcribe suggests 50–200ms chunks; 100ms keeps
 * the partial cadence responsive without a frame per render quantum. */
const CHUNK_MILLISECONDS = 100

const WORKLET_URL = '/pcm-capture-processor.js'

export interface MicCaptureResult {
  micState: MicState
  /** Tap the dial. In `connecting` it starts capture (the gesture some browsers
   * require before an AudioContext will run); in `listening` it means "that's the
   * speech done". */
  tapMic: () => void
  retry: () => void
  /** Which beat of the block she's believed to be on — what "Line?" hands over
   * next. Never moves backwards within a block. */
  beatIndex: number
  /** Live transcript, partials included. For display only: a partial can be
   * rewritten, so nothing scoreable may be derived from it. */
  transcript: string
  /** Per-beat text once the block is done — the (expected, heard) pairs the
   * comparison step will score. Empty until `captured`. */
  heard: { lineId: string; beatNumber: number; heard: string }[]
}

/**
 * @param blockId       the block she is delivering, or undefined when it isn't her turn
 * @param characterId   the character she is rehearsing as
 */
export function useMicCapture(blockId: string | undefined, characterId: string | undefined): MicCaptureResult {
  const [micState, setMicState] = useState<MicState>('connecting')
  const [beatIndex, setBeatIndex] = useState(0)
  const [transcript, setTranscript] = useState('')
  const [heard, setHeard] = useState<MicCaptureResult['heard']>([])
  // Bumped by retry() to re-run the effect below without changing the block.
  const [attempt, setAttempt] = useState(0)

  // Kept in refs rather than state because they are teardown handles, not
  // rendered values — and because the audio callback must not re-close over a
  // new render's copy on every frame.
  const socketRef = useRef<CaptureSocket>(null)
  const streamRef = useRef<MediaStream>(null)
  const contextRef = useRef<AudioContext>(null)

  const teardown = useCallback(() => {
    socketRef.current?.close()
    socketRef.current = null
    // Stopping the tracks is what turns the browser's recording indicator off.
    // Leaving them live between blocks would leave it lit through the whole
    // rehearsal, which reads as the app listening when it isn't.
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    void contextRef.current?.close()
    contextRef.current = null
  }, [])

  useEffect(() => {
    if (!blockId || !characterId) return

    let cancelled = false
    setMicState('connecting')
    setBeatIndex(0)
    setTranscript('')
    setHeard([])

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            // Echo cancellation is the cheap half of the barge-in problem
            // (docs/capture-plan.md §8): the previous character's Polly audio is
            // playing out of the same laptop the mic is on, and without this it
            // gets transcribed as her words. Headphones are the real fix.
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream

        // Asking the context for 16 kHz gets the browser's own resampler to do
        // the downsampling, which is better than anything we'd write. The worklet
        // still handles the other case, because a browser may ignore this.
        const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
        contextRef.current = context
        await context.audioWorklet.addModule(WORKLET_URL)
        if (cancelled) return

        const socket = openCaptureSocket(blockId!, characterId!, {
          onEvent: (event: CaptureEvent) => {
            if (cancelled) return
            switch (event.type) {
              case 'ready':
                // Only now is there anything on the far end to hear her.
                setMicState((current) => (current === 'connecting' ? 'listening' : current))
                break
              case 'progress':
                setBeatIndex(event.beatIndex)
                setTranscript(event.transcript)
                break
              case 'complete':
                setHeard(event.heard)
                setMicState('captured')
                break
              case 'error':
                setMicState('cantHear')
                break
            }
          },
          onClose: (wasClean) => {
            if (cancelled) return
            // A socket that closes before `complete` arrived means the capture
            // was lost, not finished — she should be told, not silently advanced
            // past a speech nobody heard.
            setMicState((current) => (current === 'captured' ? current : wasClean ? current : 'cantHear'))
          },
        })
        socketRef.current = socket

        const source = context.createMediaStreamSource(stream)
        const worklet = new AudioWorkletNode(context, 'pcm-capture-processor', {
          processorOptions: {
            targetSampleRate: TARGET_SAMPLE_RATE,
            chunkMilliseconds: CHUNK_MILLISECONDS,
          },
        })
        worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => socket.sendAudio(event.data)
        source.connect(worklet)
        // Deliberately not connected to context.destination: routing her own mic
        // to the speakers would feed back, and there is nothing to listen to
        // anyway. A worklet that produces no output still runs.

        // Autoplay policy suspends a context created without a user gesture.
        // Auto-resume covers the common case (she has already tapped something to
        // get here); if it doesn't take, the state stays `connecting` and the
        // dial's own copy already says to tap it.
        if (context.state === 'suspended') await context.resume()
      } catch (err) {
        if (cancelled) return
        // Denied permission, no mic, or a worklet that wouldn't load. All the
        // same to her: the app can't hear her, and the fallback is to call for
        // the line or mark it said (BE_PLAN.md §5).
        console.error('Mic capture could not start:', err)
        setMicState('cantHear')
      }
    }

    void start()

    return () => {
      cancelled = true
      teardown()
    }
  }, [blockId, characterId, attempt, teardown])

  const tapMic = useCallback(() => {
    // In `connecting`, the tap is the user gesture the AudioContext was waiting
    // for. Resuming a context that is already running is a no-op, so this is safe
    // even when the auto-resume above already worked.
    if (micState === 'connecting') {
      void contextRef.current?.resume().then(() => {
        if (contextRef.current?.state === 'running' && socketRef.current) setMicState('listening')
      })
      return
    }

    if (micState === 'listening') {
      // Ends the audio, which ends the Transcribe stream server-side. `complete`
      // comes back with the per-beat split, which is what moves us to `captured` —
      // so `processing` here is a real wait on the last partials settling, not a
      // cosmetic delay like the simulation's was.
      setMicState('processing')
      socketRef.current?.finish()
    }
  }, [micState])

  const retry = useCallback(() => {
    teardown()
    setAttempt((n) => n + 1)
  }, [teardown])

  return { micState, tapMic, retry, beatIndex, transcript, heard }
}
