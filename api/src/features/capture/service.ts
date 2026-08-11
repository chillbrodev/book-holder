import { DbClient } from "../../clients/cockroach-db/dbClient.ts";
import { TranscribeClient } from "../../clients/transcribe-client/transcribeClient.ts";
import { alignToBeats, type BeatProgress } from "./beatCursor.ts";
import { AudioQueue } from "./audioQueue.ts";
import { CaptureError } from "./errors.ts";
// Type-only, and deliberately the only thing capture knows about coaching: the
// `scored` event travels on this socket, so the protocol is described in one
// place, but nothing here calls the coach or knows that Bedrock exists.
import type { BlockCoaching } from "../coaching/types.ts";

export type BlockBeat = {
  lineId: string;
  beatNumber: number;
  text: string;
};

/** `beat_number` is `number | string` because `pg` returns 64-bit INTs as
 * strings to avoid precision loss — same convention as every raw row type in
 * features/plays (BE_PLAN.md §1a). */
type RawBeatRow = {
  id: string;
  beat_number: number | string;
  text: string;
  character_name: string;
  play_title: string;
};

export type CaptureBlock = {
  blockId: string;
  characterName: string;
  playTitle: string;
  beats: BlockBeat[];
};

/** What the server sends down the socket. Deliberately small: the client already
 * has the beat texts from the dialogue endpoint, so progress only needs to say
 * *where* she is, not what she was supposed to say. */
export type CaptureEvent =
  | { type: "ready"; blockId: string; beatCount: number }
  | {
    type: "progress";
    beatIndex: number;
    beatsCompleted: number;
    progressThroughBeat: number;
    transcript: string;
    /** True while Transcribe may still rewrite this text. The UI may show it;
     * nothing may score it (docs/capture-plan.md §7). */
    isPartial: boolean;
  }
  | {
    type: "complete";
    /** Index-aligned with the block's beats. The (expected, heard) pairs the
     * comparison step will score — this is capture's actual output. */
    heard: { lineId: string; beatNumber: number; heard: string }[];
    /** Audio actually forwarded, keepalive silence included. Billed seconds are
     * `max(15, this)` — see docs/capture-plan.md §5. */
    secondsForwarded: number;
  }
  | ({
    /**
     * How the block was judged. Arrives after `complete`, on the same socket,
     * roughly a second later — one Bedrock call behind.
     *
     * A separate event rather than a field on `complete` because the two have
     * different guarantees. `complete` is capture's own output and always
     * arrives; `scored` is a round trip to another service and may be late, may
     * be the deterministic fallback, and on a socket she closed by walking away
     * may never arrive at all. `coaching-plan.md` §4 designs the UI for exactly
     * that — the annotation slot is reserved from the start and tolerates being
     * a block behind, so nothing waits on this.
     */
    type: "scored";
  } & BlockCoaching)
  | { type: "error"; name: string; msg: string };

/**
 * What capture actually produced: the (expected, heard) pairs for one block,
 * with the context needed to judge them.
 *
 * Returned from `run()` rather than only emitted, so the caller can score it,
 * persist it, or ignore it. Capture's job ends at "here is what she said" —
 * keeping the decision about what happens next outside this file is what stops
 * `features/capture` growing a dependency on coaching and on sessions.
 */
export interface CaptureResult {
  blockId: string;
  playTitle: string;
  characterName: string;
  beats: {
    lineId: string;
    beatNumber: number;
    expected: string;
    heard: string;
  }[];
}

/**
 * The block's beats, in order, with their line ids.
 *
 * Joins through `line_speakers` rather than trusting a `characterId` filter,
 * because a speech can have more than one speaker (BE_PLAN.md §1a) — and this
 * doubles as the check that the character she's rehearsing actually speaks this
 * block. Same shape of query as `PollyService.getBlockAudio`, for the same
 * reason: the grouping into blocks was decided by the importer and persisted as
 * `block_id`, so it is never re-derived from anything a client sends.
 *
 * Returns each beat separately where Polly's query `string_agg`s them — the
 * difference is the whole domain distinction. Polly renders a block as one
 * utterance; scoring happens per beat.
 */
async function getBlockBeats(
  blockId: string,
  characterId: string,
): Promise<CaptureBlock> {
  const result = await DbClient.getPool().query(
    `SELECT l.id, l.beat_number, l.text, c.name AS character_name, p.title AS play_title
       FROM lines l
       JOIN line_speakers ls ON ls.line_id = l.id AND ls.character_id = $2
       JOIN characters c ON c.id = ls.character_id
       JOIN plays p ON p.id = l.play_id
      WHERE l.block_id = $1
      ORDER BY l.beat_number`,
    [blockId, characterId],
  );

  if (result.rows.length === 0) {
    throw new CaptureError(
      "BLOCK_NOT_FOUND",
      `No block ${blockId} spoken by character ${characterId}.`,
    );
  }

  return {
    blockId,
    characterName: result.rows[0].character_name,
    playTitle: result.rows[0].play_title,
    // Number() at the mapping boundary, not decoration: `pg` returns 64-bit INTs
    // as strings to avoid precision loss (BE_PLAN.md §1a).
    beats: result.rows.map((row: RawBeatRow) => ({
      lineId: row.id,
      beatNumber: Number(row.beat_number),
      text: row.text,
    })),
  };
}

/**
 * One block's capture: audio in, beat progress out.
 *
 * Lives server-side because the beat cursor needs the expected beat texts, and
 * those are the answer key to what she's being tested on — see
 * docs/capture-plan.md §4 for why the browser doesn't hold the Transcribe stream
 * itself.
 */
export class CaptureSession {
  readonly #block: CaptureBlock;
  readonly #emit: (event: CaptureEvent) => void;
  readonly #queue: AudioQueue;
  #progress: BeatProgress;
  /** Clamped non-decreasing across updates. `alignToBeats` is pure and will
   * report a lower beat if a revised partial retracts words — correct for a
   * single alignment, wrong for a cursor she is watching, because a beat that
   * un-advances reads as the app losing its place. */
  #highWaterBeat = 0;
  /** Every segment Transcribe has committed to, joined. A partial is appended to
   * this rather than replacing it, because a partial only ever revises the tail
   * of the *current* segment. */
  #finalized = "";

  private constructor(
    block: CaptureBlock,
    emit: (event: CaptureEvent) => void,
  ) {
    this.#block = block;
    this.#emit = emit;
    this.#queue = new AudioQueue({
      onLimitReached: () =>
        console.warn(
          `Capture for block ${block.blockId} hit the duration ceiling — ` +
            `closing the stream rather than billing an open mic indefinitely.`,
        ),
    });
    this.#progress = alignToBeats(this.#beatTexts, "");
  }

  static async open(
    input: { blockId?: string; characterId?: string },
    emit: (event: CaptureEvent) => void,
  ): Promise<CaptureSession> {
    const { blockId, characterId } = input;
    if (!blockId?.trim() || !characterId?.trim()) {
      throw new CaptureError(
        "VALIDATION_ERROR",
        "blockId and characterId are both required.",
      );
    }
    const block = await getBlockBeats(blockId, characterId);
    return new CaptureSession(block, emit);
  }

  get #beatTexts(): string[] {
    return this.#block.beats.map((beat) => beat.text);
  }

  /** Where she is now — what "Line?" reads to decide which beat to hand over. */
  get beatIndex(): number {
    return this.#highWaterBeat;
  }

  pushAudio(chunk: Uint8Array): void {
    this.#queue.push(chunk);
  }

  /** She's finished the block (or navigated away). Ends the audio, which ends
   * the Transcribe stream and lets `run()` finish. */
  finish(): void {
    this.#queue.close();
  }

  /**
   * Drives the stream to completion. Resolves once Transcribe has closed.
   *
   * Errors are emitted rather than thrown: by the time this is running the
   * WebSocket is already open, so there is no HTTP response left to fail. A
   * capture that dies mid-block must leave the rehearsal usable — she marks the
   * beat as said and carries on (BE_PLAN.md §5).
   *
   * Resolves with the block's (expected, heard) pairs, or `undefined` if
   * Transcribe failed and there is nothing to judge. `undefined` rather than an
   * empty result on purpose: a block where she said nothing is a real outcome
   * that should still be scored (every beat dry), and a block that never
   * listened is not. Collapsing them would record silence she was never asked
   * for.
   */
  async run(): Promise<CaptureResult | undefined> {
    this.#emit({
      type: "ready",
      blockId: this.#block.blockId,
      beatCount: this.#block.beats.length,
    });

    try {
      for await (const update of TranscribeClient.transcribe(this.#queue)) {
        // Transcribe's transcript is per *segment*, and a segment is not a beat —
        // measured against one real 8-beat speech, Transcribe returned 6 segments
        // and one of them spanned beats 2, 3 and 4 on its own. So the whole
        // transcript has to be reassembled here: aligning a single segment
        // against the block would restart `heardByBeat` from empty at every
        // segment boundary and report only the last segment's words at the end.
        const transcript = this.#finalized
          ? `${this.#finalized} ${update.transcript}`
          : update.transcript;
        if (!update.isPartial) this.#finalized = transcript;

        this.#progress = alignToBeats(this.#beatTexts, transcript);
        this.#highWaterBeat = Math.max(
          this.#highWaterBeat,
          this.#progress.beatIndex,
        );
        this.#emit({
          type: "progress",
          beatIndex: this.#highWaterBeat,
          beatsCompleted: this.#progress.beatsCompleted,
          progressThroughBeat: this.#progress.progressThroughBeat,
          transcript,
          isPartial: update.isPartial,
        });
      }
    } catch (err) {
      console.error(
        `Transcribe stream failed for block ${this.#block.blockId}:`,
        err,
      );
      this.#queue.close();
      const error = new CaptureError(
        "LISTENING_UNAVAILABLE",
        "Transcribe is unavailable, so this block wasn't heard.",
        { cause: err, context: { blockId: this.#block.blockId } },
      );
      this.#emit({ type: "error", name: error.name, msg: error.message });
      return;
    }

    const beats = this.#block.beats.map((beat, index) => ({
      lineId: beat.lineId,
      beatNumber: beat.beatNumber,
      expected: beat.text,
      heard: this.#progress.heardByBeat[index] ?? "",
    }));

    this.#emit({
      type: "complete",
      // The client already has the beat texts from the dialogue endpoint, so
      // `expected` is stripped here rather than sent — the event stays as small
      // as it was, while the return value below carries what the server needs.
      heard: beats.map(({ lineId, beatNumber, heard }) => ({
        lineId,
        beatNumber,
        heard,
      })),
      secondsForwarded: Number(this.#queue.secondsForwarded.toFixed(2)),
    });

    return {
      blockId: this.#block.blockId,
      playTitle: this.#block.playTitle,
      characterName: this.#block.characterName,
      beats,
    };
  }
}
