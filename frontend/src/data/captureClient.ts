/**
 * The mic socket: PCM up, beat progress down.
 *
 * A WebSocket rather than a fetch because capture is continuous and
 * bidirectional for the length of one speech — see docs/capture-plan.md §4 for
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
      /** True while Transcribe may still rewrite this text — safe to show,
       * never safe to score. */
      isPartial: boolean
    }
  | {
      type: 'complete'
      heard: { lineId: string; beatNumber: number; heard: string }[]
      secondsForwarded: number
    }
  | { type: 'error'; name: string; msg: string }

/** http(s) → ws(s) on the configured API origin, rather than a second env var
 * that could drift out of step with VITE_API_BASE_URL and only fail in a
 * deployed environment. */
function captureUrl(blockId: string, characterId: string): string {
  const base = API_BASE_URL.replace(/^http/, 'ws')
  return `${base}/capture/blocks/${blockId}?characterId=${encodeURIComponent(characterId)}`
}

export interface CaptureSocket {
  /** Audio frames straight from the worklet. Dropped silently if the socket
   * isn't open — losing a frame is better than throwing on the audio path. */
  sendAudio: (pcm: ArrayBuffer) => void
  /** She's finished the speech. The socket stays open until the server's
   * `complete` arrives, so this is not the same as closing. */
  finish: () => void
  close: () => void
}

export function openCaptureSocket(
  blockId: string,
  characterId: string,
  handlers: {
    onOpen?: () => void
    onEvent: (event: CaptureEvent) => void
    onClose?: (wasClean: boolean) => void
  },
): CaptureSocket {
  const socket = new WebSocket(captureUrl(blockId, characterId))
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
