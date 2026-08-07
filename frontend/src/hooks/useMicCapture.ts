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

/**
 * How long to keep listening after the beat cursor says she's finished the block.
 *
 * The cursor completing is good evidence the speech is done, but not proof: a
 * trailing word can still be in flight, and Transcribe revises the tail of a
 * partial. Ending the stream the instant the last beat is accounted for would
 * clip whatever came after it. Just under a second is long enough to catch a
 * trailing clause and short enough not to feel like a wait.
 */
const AUTO_FINISH_SETTLE_MS = 900

/**
 * How long she has to be quiet before the app decides she's stopped speaking.
 *
 * Silence is the signal, because text isn't. A completed beat cursor is *one* way
 * to know she's finished, and it is not reliable enough to be the only one: real
 * failure, from a real run — "Ay, cousin Slender, and 'Custalourum" came back as
 * "I, Cousin Slender, and Castellorum", 4 of 5 words matched, and the block could
 * never complete because "'Custalourum" is four edits from what Transcribe heard
 * and "Ay" is too short to match fuzzily at all. She had said the line. The app
 * sat there listening, and she had no idea what it wanted.
 *
 * A human scene partner doesn't wait to be told the line is over — they hear you
 * stop. Partials arrive several times a second while she's talking and stop
 * entirely when she isn't, so "no transcript activity" is a good proxy for
 * silence without analysing audio levels.
 *
 * Longer than the settle window because this fires on incomplete text: it has to
 * outlast a breath in the middle of a thought.
 */
const SILENCE_MS = 2500

/**
 * How much of the beat she must have delivered for silence to mean "finished"
 * rather than "dried up".
 *
 * This is the rule that tells the two apart, and it is deliberately about
 * proportion rather than a text threshold. If she has said most of the words and
 * gone quiet, she is waiting on the app. If she has said hardly any and gone
 * quiet, she is waiting on herself — and finishing the block for her would take
 * away the "Line?" she actually needs.
 *
 * Not the fuzzy-match threshold (docs/OPEN_ITEMS.md §1a), and not a score: this
 * decides who the app is waiting for, never whether she got it right.
 */
const MOSTLY_DELIVERED = 0.5

export interface MicCaptureResult {
  micState: MicState
  /** Tap the dial. In `connecting` it starts capture (the gesture some browsers
   * require before an AudioContext will run); in `listening` it means "that's the
   * speech done". Not the normal path — she stops talking and the app takes its
   * cue — but always available, and surfaced as a real button rather than only as
   * a tap on a status dial, because a dial doesn't look like a control. */
  tapMic: () => void
  retry: () => void
  /** Beats accounted for, and how many the block has. Lets the UI show her that
   * it's following along rather than just asserting that it's listening. */
  beatsCompleted: number
  beatCount: number
  /**
   * She's gone quiet without the app being able to tell she finished — she has
   * said little of the beat and stopped.
   *
   * The one case where the app genuinely needs her to say what's happening, so it
   * is the one case that should ask. Distinct from "listening": the UI must not
   * keep claiming to follow along when it has stopped being able to.
   */
  stalled: boolean
  /**
   * Silences the mic at the source without tearing the stream down.
   *
   * For playing her own line back to her: Polly coming out of the same laptop
   * the mic is on would otherwise be transcribed as her words — barge-in
   * (docs/capture-plan.md §8), self-inflicted. Disabling the track makes the
   * worklet see zeroes, which is silence, which is exactly what the keepalive
   * sends anyway — so the Transcribe stream stays alive and simply hears nothing.
   */
  setMuted: (muted: boolean) => void
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
  const [beatsCompleted, setBeatsCompleted] = useState(0)
  const [beatCount, setBeatCount] = useState(0)
  const [transcript, setTranscript] = useState('')
  const [heard, setHeard] = useState<MicCaptureResult['heard']>([])
  const [stalled, setStalled] = useState(false)
  // Bumped by retry() to re-run the effect below without changing the block.
  const [attempt, setAttempt] = useState(0)

  // Kept in refs rather than state because they are teardown handles, not
  // rendered values — and because the audio callback must not re-close over a
  // new render's copy on every frame.
  const socketRef = useRef<CaptureSocket>(null)
  const streamRef = useRef<MediaStream>(null)
  const contextRef = useRef<AudioContext>(null)
  const autoFinishRef = useRef<ReturnType<typeof setTimeout>>(null)
  // Also refs, not just state: the socket's event handler closes over this
  // render's values, so it would evaluate against stale progress.
  const beatCountRef = useRef(0)
  const progressRef = useRef({ beatsCompleted: 0, progressThroughBeat: 0 })

  const endCapture = useCallback(() => {
    if (autoFinishRef.current) {
      clearTimeout(autoFinishRef.current)
      autoFinishRef.current = null
    }
    setStalled(false)
    setMicState((current) => (current === 'listening' ? 'processing' : current))
    socketRef.current?.finish()
  }, [])

  /**
   * Restarts the "has she stopped talking?" clock. Called on every transcript
   * update, so it only expires once words stop arriving.
   *
   * When it expires, the block is either finished or she's stuck, and the
   * difference is how much of the beat she got through — see MOSTLY_DELIVERED.
   * The app decides for itself in the first case and asks in the second; what it
   * must not do is keep saying "Listening" when it has stopped being able to tell.
   */
  const scheduleSilenceCheck = useCallback(() => {
    if (autoFinishRef.current) clearTimeout(autoFinishRef.current)

    const { beatsCompleted: completed, progressThroughBeat } = progressRef.current
    const total = beatCountRef.current
    const blockComplete = total > 0 && completed >= total
    // On the last beat with most of it said. The cursor can't confirm the end
    // when the closing word is a name Transcribe has never met — "'Custalourum",
    // "Coram", "Custalorum" — which is most of what Shallow and Slender say.
    const finishedLastBeat = total > 0 &&
      completed >= total - 1 &&
      progressThroughBeat >= MOSTLY_DELIVERED

    autoFinishRef.current = setTimeout(
      () => {
        autoFinishRef.current = null
        if (blockComplete || finishedLastBeat) {
          endCapture()
          return
        }
        // She stopped with the thought unfinished. Say so, and let the page offer
        // the line rather than silently waiting for something that isn't coming.
        setStalled(true)
      },
      blockComplete ? AUTO_FINISH_SETTLE_MS : SILENCE_MS,
    )
  }, [endCapture])

  const teardown = useCallback(() => {
    if (autoFinishRef.current) {
      clearTimeout(autoFinishRef.current)
      autoFinishRef.current = null
    }
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
    // Reset before the early return, not after it. When it stops being her turn
    // `blockId` goes undefined, and leaving the previous block's state behind
    // means the hook keeps reporting `captured` while no mic is open at all —
    // which the page reads as "her speech just finished" and acts on.
    let cancelled = false
    setMicState('connecting')
    setBeatIndex(0)
    setBeatsCompleted(0)
    setBeatCount(0)
    beatCountRef.current = 0
    progressRef.current = { beatsCompleted: 0, progressThroughBeat: 0 }
    setStalled(false)
    setTranscript('')
    setHeard([])

    if (!blockId || !characterId) return

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
                beatCountRef.current = event.beatCount
                setBeatCount(event.beatCount)
                setMicState((current) => (current === 'connecting' ? 'listening' : current))
                break
              case 'progress':
                setBeatIndex(event.beatIndex)
                setBeatsCompleted(event.beatsCompleted)
                setTranscript(event.transcript)
                progressRef.current = {
                  beatsCompleted: event.beatsCompleted,
                  progressThroughBeat: event.progressThroughBeat,
                }
                // Words are still arriving, so she hasn't stopped — whatever the
                // text looks like.
                setStalled(false)
                scheduleSilenceCheck()
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
    // scheduleSilenceCheck and teardown are stable (useCallback over refs and
    // setters only), so listing them can't restart a live capture.
  }, [blockId, characterId, attempt, teardown, scheduleSilenceCheck])

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
      // She's saying she's done. Ends the audio, which ends the Transcribe stream
      // server-side; `complete` comes back with the per-beat split, which is what
      // moves us to `captured` — so `processing` is a real wait on the last
      // partials settling, not a cosmetic delay like the simulation's was.
      endCapture()
    }
  }, [micState, endCapture])

  const setMuted = useCallback((muted: boolean) => {
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !muted
    })
  }, [])

  const retry = useCallback(() => {
    teardown()
    setAttempt((n) => n + 1)
  }, [teardown])

  return {
    micState,
    tapMic,
    retry,
    beatIndex,
    beatsCompleted,
    beatCount,
    stalled,
    transcript,
    heard,
    setMuted,
  }
}
