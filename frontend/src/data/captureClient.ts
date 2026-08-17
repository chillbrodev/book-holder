/**
 * The mic socket: PCM up, beat progress down.
 *
 * A WebSocket rather than a fetch because capture is continuous and
 * bidirectional for the length of one speech. See docs/capture-plan.md §4 for
 * why the browser talks to our API rather than to Amazon Transcribe directly
 * (short version: a presigned Transcribe URL is a spendable credential, and the
 * beat cursor needs the answer key, which lives in the database).
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000'

/** Mirrors api's CaptureEvent (features/capture/service.ts). */
export type CaptureEvent =
  | { type: 'ready'; blockId: string; beatCount: number }
  | {
      type: 'progress'
      beatIndex: number
      beatsCompleted: number
      progressThroughBeat: number
      transcript: string
      /** True while Transcribe may still rewrite this text, safe to show,
       * never safe to score. */
      isPartial: boolean
    }
  | {
      type: 'complete'
      heard: { lineId: string; beatNumber: number; heard: string }[]
      secondsForwarded: number
    }
  | {
      /**
       * How the block was judged. Arrives after `complete`, about a second
       * later, one Bedrock call behind.
       *
       * May not arrive at all: it is a round trip to another service, and a
       * socket she closed by walking away never sees it. Nothing in the UI may
       * wait on this (docs/coaching-plan.md §4); the annotation slot is
       * reserved from the start and tolerates being a block behind.
       */
      type: 'scored'
      blockId: string
      beats: { lineId: string; confidence: number; band: Band }[]
      /** Empty when there was nothing worth saying, which is common and correct. */
      note: string
      /** `fallback` means Bedrock was slow or down and word recall stood in.
       * Worth knowing: a rehearsal that quietly ran on word overlap all evening
       * looks exactly like one that was coached. */
      source: 'bedrock' | 'fallback'
    }
  | { type: 'error'; name: string; msg: string }

/** *solid* / *close* / *dry*, never a percentage. A grade is a teacher's
 * register and the style guide's voice is backstage crew; "dry" is what someone
 * in the wings actually says about a forgotten line. */
export type Band = 'solid' | 'close' | 'dry'

/** http(s) → ws(s) on the configured API origin, rather than a second env var
 * that could drift out of step with VITE_API_BASE_URL and only fail in a
 * deployed environment. */
function captureUrl(blockId: string, characterId: string, sessionId?: string): string {
  const base = API_BASE_URL.replace(/^http/, 'ws')
  const query = new URLSearchParams({ characterId })
  // Optional, and its absence is never an error. No session means a guest, or a
  // rehearsal begun before one could be opened; she is coached either way and
  // only the memory is missing (docs/coaching-plan.md §7).
  if (sessionId) query.set('sessionId', sessionId)
  return `${base}/capture/blocks/${blockId}?${query}`
}

export interface CaptureSocket {
  /** Audio frames straight from the worklet. Dropped silently if the socket
   * isn't open, losing a frame is better than throwing on the audio path. */
  sendAudio: (pcm: ArrayBuffer) => void
  /** She's finished the speech. The socket stays open until the server's
   * `complete` arrives, so this is not the same as closing. */
  finish: () => void
  close: () => void
}

/**
 * `accessToken` is how a rehearsal gets remembered, and its absence is never an
 * error — a guest opens the same socket, gets the same mic and the same live
 * coaching, and only the writing-down is missing.
 *
 * It travels as a WebSocket *subprotocol* rather than a query parameter,
 * because a browser `WebSocket` cannot set an `Authorization` header and a URL
 * is written into every access log along the way. The server reads the second
 * offered protocol as the token and echoes back the `bearer` sentinel; see
 * api/src/features/auth/bearer.ts. Both entries are valid protocol tokens — a
 * JWT is base64url plus dots, all of which RFC 7230 allows.
 */
export function openCaptureSocket(
  blockId: string,
  characterId: string,
  handlers: {
    onOpen?: () => void
    onEvent: (event: CaptureEvent) => void
    onClose?: (wasClean: boolean) => void
  },
  sessionId?: string,
  accessToken?: string | null,
): CaptureSocket {
  const socket = accessToken
    ? new WebSocket(captureUrl(blockId, characterId, sessionId), ['bearer', accessToken])
    : new WebSocket(captureUrl(blockId, characterId, sessionId))
  // The server reads binary frames as PCM and text frames as control messages,
  // so the frames it sends back must arrive as something we can JSON.parse
  // rather than as a Blob we'd have to await.
  socket.binaryType = 'arraybuffer'

  socket.onopen = () => handlers.onOpen?.()
  socket.onmessage = (event) => {
    if (typeof event.data !== 'string') return
    try {
      handlers.onEvent(JSON.parse(event.data) as CaptureEvent)
    } catch {
      // A frame we can't parse is not worth tearing a live capture down for.
    }
  }
  socket.onclose = (event) => handlers.onClose?.(event.wasClean)
  socket.onerror = () =>
    handlers.onEvent({
      type: 'error',
      name: 'CAPTURE_UNAVAILABLE',
      msg: "The mic couldn't reach the coach.",
    })

  return {
    sendAudio: (pcm) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(pcm)
    },
    finish: () => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'done' }))
    },
    close: () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close()
      }
    },
  }
}
