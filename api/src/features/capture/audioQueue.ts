import {
  TRANSCRIBE_BYTES_PER_SAMPLE,
  TRANSCRIBE_SAMPLE_RATE,
} from "../../clients/transcribe-client/transcribeClient.ts";

/**
 * Bridges a push source (WebSocket frames arriving from the browser) to the pull
 * source the AWS SDK wants (an async iterable it drains).
 *
 * Also the place two operational hazards are handled, both of which are about
 * time rather than audio: a stream that Transcribe hangs up on because she went
 * quiet, and a stream nobody ever closes.
 */

/** Silence sent after this long without real audio.
 *
 * Transcribe closes a stream that goes 15 seconds without receiving audio, and a
 * rehearsal is full of longer silences that are not failures: she is thinking,
 * or she tapped "Line?" and is reading the beat that came back. Losing the stream
 * there would mean the rest of her speech went uncaptured and she'd find out at
 * the wrap-up.
 *
 * Five seconds leaves two keepalives' worth of margin before the 15-second
 * deadline, so one delayed timer doesn't cost the session.
 *
 * Generated here rather than asked of the client on purpose: the client going
 * quiet — a backgrounded tab, a wedged worklet, a flaky connection — is one of
 * the cases this is protecting against, so it cannot be the thing responsible
 * for preventing it. */
const KEEPALIVE_IDLE_MS = 5_000;

/** How much silence a keepalive sends. Long enough to be unambiguously audio,
 * short enough that the billed audio it adds is noise: 200ms per 5s idle is 4%
 * of the silence it spans, against a 15-second billing floor it is protecting
 * (docs/capture-plan.md §5). */
const KEEPALIVE_SILENCE_MS = 200;

/**
 * Hard ceiling on one capture.
 *
 * The longest block in the corpus is 104.7 seconds of Polly delivery, so 180
 * gives comfortable headroom for a human taking her time, and still bounds what
 * a stuck client can spend. Without a ceiling, a browser tab left open with a
 * live mic bills Transcribe until someone notices — the runaway-call guard
 * BE_PLAN.md §4 asks for, applied to the one path here that bills by the second.
 */
const MAX_CAPTURE_SECONDS = 180;

const BYTES_PER_MS = (TRANSCRIBE_SAMPLE_RATE * TRANSCRIBE_BYTES_PER_SAMPLE) /
  1000;

/** Zeroed PCM. 16-bit signed little-endian silence really is all zeroes, so this
 * needs no encoding step. */
const SILENCE = new Uint8Array(KEEPALIVE_SILENCE_MS * BYTES_PER_MS);

export type AudioQueueOptions = {
  /** Overridable so tests don't have to wait in real time. */
  keepaliveIdleMs?: number;
  maxCaptureSeconds?: number;
  onLimitReached?: () => void;
};

export class AudioQueue {
  #pending: Uint8Array[] = [];
  #closed = false;
  #wake?: () => void;
  // ReturnType, not number: pulling in the AWS SDK brings Node's typings along,
  // which widen setTimeout's return to Timeout.
  #keepaliveTimer?: ReturnType<typeof setTimeout>;
  #bytesForwarded = 0;
  #keepalivesSent = 0;
  readonly #keepaliveIdleMs: number;
  readonly #maxBytes: number;
  readonly #onLimitReached?: () => void;

  constructor(options: AudioQueueOptions = {}) {
    this.#keepaliveIdleMs = options.keepaliveIdleMs ?? KEEPALIVE_IDLE_MS;
    this.#maxBytes = (options.maxCaptureSeconds ?? MAX_CAPTURE_SECONDS) *
      TRANSCRIBE_SAMPLE_RATE * TRANSCRIBE_BYTES_PER_SAMPLE;
    this.#onLimitReached = options.onLimitReached;
  }

  /** Seconds of audio actually forwarded — what Transcribe bills on, keepalive
   * silence included, so it can be logged against the real cost. */
  get secondsForwarded(): number {
    return this.#bytesForwarded /
      (TRANSCRIBE_SAMPLE_RATE * TRANSCRIBE_BYTES_PER_SAMPLE);
  }

  get keepalivesSent(): number {
    return this.#keepalivesSent;
  }

  get closed(): boolean {
    return this.#closed;
  }

  push(chunk: Uint8Array): void {
    if (this.#closed || chunk.byteLength === 0) return;
    this.#pending.push(chunk);
    this.#wake?.();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearKeepalive();
    // Wakes the iterator so it can observe the close and return, rather than
    // waiting forever on a queue nothing will ever push to again.
    this.#wake?.();
  }

  #clearKeepalive(): void {
    if (this.#keepaliveTimer !== undefined) {
      clearTimeout(this.#keepaliveTimer);
      this.#keepaliveTimer = undefined;
    }
  }

  #armKeepalive(): void {
    this.#clearKeepalive();
    if (this.#closed) return;
    this.#keepaliveTimer = setTimeout(() => {
      if (this.#closed) return;
      this.#keepalivesSent++;
      this.#pending.push(SILENCE);
      this.#wake?.();
    }, this.#keepaliveIdleMs);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    try {
      while (true) {
        if (this.#pending.length === 0) {
          if (this.#closed) return;
          this.#armKeepalive();
          await new Promise<void>((resolve) => {
            this.#wake = resolve;
          });
          this.#wake = undefined;
          this.#clearKeepalive();
          continue;
        }

        const chunk = this.#pending.shift()!;
        this.#bytesForwarded += chunk.byteLength;
        yield chunk;

        if (this.#bytesForwarded >= this.#maxBytes) {
          // Ends the stream from this side rather than waiting for a client that
          // has already shown it isn't going to stop.
          this.#onLimitReached?.();
          this.close();
          return;
        }
      }
    } finally {
      // Covers the abnormal exits too — an SDK error, or the consumer breaking
      // out of the loop — so a dropped stream can never leave a timer holding
      // the process awake.
      this.#clearKeepalive();
      this.#closed = true;
    }
  }
}
