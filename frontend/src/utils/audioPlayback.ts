/**
 * Every line the app speaks goes through one shared <audio> element, plus the
 * one-time unlock that iOS Safari wants before it will play anything.
 *
 * Why a singleton rather than `new Audio(url)` per line, which is what this
 * replaced: **iOS Safari grants playback per element, not per page.** An element
 * that has been played once inside a user gesture stays playable for the rest of
 * the session, and you can reassign its `src` freely afterwards. A freshly
 * constructed element has no such grant and needs its own gesture, which an
 * app that plays one speech after another can never give it.
 *
 * The failure that produced this module: the rehearsal screen fetched a URL,
 * built a new element in the `.then()`, and called `play()`. Two things made
 * that unplayable on iOS — the element was new, and `play()` sat behind a
 * network await, which ends any user activation the triggering tap had. The
 * rejection landed in the same `.catch()` written for "the Polly request
 * failed", whose job is to keep the rehearsal moving, so every other
 * character's speech was skipped 650ms apart in silence until the next line
 * belonging to the actor. Reported from a real iPhone; it is not reproducible
 * in desktop Safari, which is far more permissive once the page has been
 * interacted with at all.
 *
 * Desktop is unaffected by design. Where autoplay is already permitted the
 * sequence is identical — set src, play, advance on `ended` — and reusing one
 * element additionally makes overlapping playback impossible, which the two
 * call sites were relying on state to prevent.
 */

/* A 46-byte mono 8kHz WAV holding a single silent sample. Generated rather than
   copied so the header is known-good; anything with a real duration would be
   audible as a click at the start of every session. */
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA=='

let element: HTMLAudioElement | null = null
let unlocked = false

/* Monotonic, so a session that has been superseded can neither fire its
   handlers nor pause audio that now belongs to a newer one. With a single
   shared element that matters in a way it didn't when each line owned its own:
   a stale `ended` listener would otherwise advance the script on the strength
   of a different speech finishing. */
let generation = 0

function getElement(): HTMLAudioElement {
  if (!element) {
    element = new Audio()
    element.preload = 'auto'
  }
  return element
}

/** True once the element has successfully played anything at all. */
export function isPlaybackUnlocked(): boolean {
  return unlocked
}

/**
 * Spend a user gesture on making the shared element playable forever after.
 *
 * Must be called *synchronously* from inside the gesture's handler — any await
 * first and the activation is gone, which is the whole bug this exists to fix.
 * Plays a silent sample and immediately rewinds, so it is inaudible and cheap.
 * Safe to call on every gesture: it returns immediately once unlocked, and a
 * failure leaves things exactly as they were for the next gesture to retry.
 */
export function unlockPlayback(): void {
  if (unlocked) return
  const el = getElement()
  el.src = SILENT_WAV
  try {
    const started = el.play()
    // Pre-promise browsers return undefined; nothing to wait on and nothing
    // that could have blocked us.
    if (!started) {
      unlocked = true
      return
    }
    void started
      .then(() => {
        el.pause()
        el.currentTime = 0
        unlocked = true
      })
      .catch(() => {
        /* Still locked. A later gesture, or the explicit prompt, can try again. */
      })
  } catch {
    /* Same. */
  }
}

/** Thrown when the browser refused to play — a permission problem, not a
 *  missing file, and the two want opposite responses from the caller. */
export class PlaybackBlockedError extends Error {
  constructor() {
    super('Playback was blocked by the browser autoplay policy')
    this.name = 'PlaybackBlockedError'
  }
}

export function isPlaybackBlocked(error: unknown): boolean {
  return error instanceof PlaybackBlockedError
}

export interface PlaybackSession {
  /** Resolves when playback has actually begun; rejects with
   *  PlaybackBlockedError if the browser refused. Never resolves on `ended` —
   *  that arrives through the onEnded handler. */
  started: Promise<void>
  /** Stops this session and detaches its handlers. Idempotent, and a no-op on
   *  the element if a newer session has already taken it over. */
  cancel: () => void
}

export interface PlaybackHandlers {
  onEnded: () => void
  onError: () => void
}

/** Play `url` on the shared element, replacing whatever was playing. */
export function playUrl(url: string, { onEnded, onError }: PlaybackHandlers): PlaybackSession {
  const el = getElement()
  const mine = ++generation
  const isCurrent = () => generation === mine

  const detach = () => {
    el.removeEventListener('ended', handleEnded)
    el.removeEventListener('error', handleError)
  }
  function handleEnded() {
    if (!isCurrent()) return
    detach()
    onEnded()
  }
  function handleError() {
    if (!isCurrent()) return
    detach()
    onError()
  }

  el.addEventListener('ended', handleEnded)
  el.addEventListener('error', handleError)
  el.src = url

  // Called synchronously, never from inside a `.then()`, so that a caller who
  // does have an active gesture keeps the benefit of it.
  let started: Promise<void>
  try {
    started = Promise.resolve(el.play()).then(() => {
      // Anything that plays proves the element is unlocked, so a rehearsal that
      // began from a real tap never needs the silent sample.
      unlocked = true
    })
  } catch (error) {
    started = Promise.reject(error)
  }

  started = started.catch((error: unknown) => {
    detach()
    // NotAllowedError is the autoplay refusal. Everything else — a decode
    // failure, a 403 on the signed URL — is a broken sound, and the caller
    // should degrade past it rather than ask the user to intervene.
    const blocked = error instanceof DOMException && error.name === 'NotAllowedError'
    throw blocked ? new PlaybackBlockedError() : error
  })

  return {
    started,
    cancel: () => {
      detach()
      if (!isCurrent()) return
      generation += 1
      el.pause()
    },
  }
}
