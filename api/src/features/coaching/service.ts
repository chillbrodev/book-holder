/**
 * One Bedrock call per block, returning a judgement per beat.
 *
 * `docs/coaching-plan.md` §1–§2 is the reasoning; this is the implementation of
 * it. The two facts worth holding while reading:
 *
 * - **The call is block-shaped; the result is per beat.** CLAUDE.md's rule is
 *   unchanged — score per beat, render and display per block. A beat out of
 *   context cannot be judged ("I have an eye to make difference of men's
 *   liking" against what she actually said needs to know what the speech is
 *   doing), so the model sees the whole speech and answers about each beat
 *   inside it. It is also ~1.6x fewer calls than one per beat.
 *
 * - **Nothing here may block a rehearsal.** Every failure path returns the
 *   deterministic scorer's answer instead of throwing. `BE_PLAN.md` §5 asks for
 *   that explicitly, and `score.ts` was built as the real scorer rather than a
 *   stub precisely so this fallback is a working code path and not a promise.
 */

import { BedrockClient } from "../../clients/bedrock-client/bedrockClient.ts";
import { ConfigClient } from "../../clients/config-client/configClient.ts";
import { scoreBeat } from "../sessions/score.ts";
import {
  COACH_RUBRIC,
  COACH_SCHEMA,
  COACH_TOOL_DESCRIPTION,
  COACH_TOOL_NAME,
} from "./rubric.ts";
import type { Band, BeatCoaching, BlockCoaching } from "./types.ts";

/** One beat as the coach needs it: what was written, and what she said. */
export interface BeatAttempt {
  lineId: string;
  beatNumber: number;
  expected: string;
  heard: string;
}

export interface CoachBlockInput {
  blockId: string;
  playTitle: string;
  characterName: string;
  beats: BeatAttempt[];
}

/**
 * Output budget. A long speech is the case that matters: ~30 tokens per beat of
 * structured output, plus the note. 900 covers a 16-beat monologue with room
 * over, and capping it at all is what stops a runaway generation costing real
 * money on a block nobody is watching.
 */
const MAX_OUTPUT_TOKENS = 900;

/**
 * How long a block's coaching may take before the fallback answers instead.
 *
 * The measured Nova Micro call was 571 ms for one beat (`coaching-plan.md` §8).
 * A block is bigger, so this is deliberately several times that rather than
 * tight: the cost of waiting is a late annotation, which §4 already designs
 * for ("scores may arrive late, and that is fine"), while the cost of cutting
 * a good answer off early is coaching that silently degrades to word overlap.
 * It exists to bound the unbounded case — a hung connection — not to police
 * normal latency.
 */
const COACH_TIMEOUT_MS = 8_000;

export interface CoachBlockOptions {
  /**
   * Overrides the configured comparison model.
   *
   * `ConfigClient` resolves its values once at module load, so an environment
   * variable cannot be changed after import — which makes this the only way to
   * exercise the failure path without a live billed call, and the only way the
   * scene summary (`coaching-plan.md` §5, deliberately a different and stronger
   * model) will be able to reuse this call shape.
   */
  modelId?: string;
}

export const CoachingService = {
  /**
   * Judge one block. Never throws: on any failure the deterministic scorer
   * answers and `source` says so.
   */
  async coachBlock(
    input: CoachBlockInput,
    options: CoachBlockOptions = {},
  ): Promise<BlockCoaching> {
    if (input.beats.length === 0) {
      return { blockId: input.blockId, beats: [], note: "", source: "bedrock" };
    }

    try {
      const result = await withTimeout(
        callModel(input, options),
        COACH_TIMEOUT_MS,
      );
      return result;
    } catch (err) {
      // Logged rather than swallowed: a rehearsal that quietly runs on word
      // overlap all evening looks exactly like one that is being coached, and
      // the only place the difference shows is here.
      console.error(
        `Coaching failed for block ${input.blockId}, falling back to word recall:`,
        err,
      );
      return fallbackCoaching(input);
    }
  },

  /** Exposed for the socket's degraded path and for tests. */
  fallbackCoaching,
};

async function callModel(
  input: CoachBlockInput,
  options: CoachBlockOptions,
): Promise<BlockCoaching> {
  const { value, usage, recoveredFromText } = await BedrockClient.converseJson<
    ModelResponse
  >({
    modelId: options.modelId ?? ConfigClient.Bedrock.comparisonModelId,
    system: COACH_RUBRIC,
    userMessage: buildUserMessage(input),
    toolName: COACH_TOOL_NAME,
    toolDescription: COACH_TOOL_DESCRIPTION,
    schema: COACH_SCHEMA,
    maxTokens: MAX_OUTPUT_TOKENS,
    // Scoring wants the same verdict for the same delivery, twice running.
    temperature: 0,
    // The rubric is byte-identical for every block in a scene and blocks land
    // well inside Nova's 5-minute TTL, so the checkpoint hits in practice
    // rather than in theory. It is ignored below Nova's 1K-token minimum — if
    // the rubric is ever trimmed under that this quietly stops helping, which
    // `usage.inputTokens` is where you would see it.
    cacheSystemPrompt: true,
  });

  if (recoveredFromText) {
    // The forced tool call didn't take. The parse still recovered a shape, so
    // the rehearsal is fine — but per the client's header this is the signal
    // that the toolChoice shape has broken, not an invitation to widen parsing.
    console.warn(
      `Coaching for block ${input.blockId} was recovered from prose — forced toolChoice may have stopped working.`,
    );
  }

  // Logged rather than returned. `BE_PLAN.md` §7 wants per-call cost visible,
  // and this is the only place that knows it — but it is a property of the call,
  // not of the coaching, and threading it through the socket to the browser
  // would put token counts in front of an actor.
  console.info(
    `Coached block ${input.blockId}: ${input.beats.length} beat(s), ` +
      `${usage.inputTokens} in / ${usage.outputTokens} out`,
  );

  return {
    blockId: input.blockId,
    beats: mapBeats(input, value),
    note: groundedNote(
      typeof value?.note === "string" ? value.note : "",
      input,
    ),
    source: "bedrock",
  };
}

/**
 * Keep the note only if it is actually about this speech; otherwise drop it.
 *
 * The rubric asks for a note built from the written words and forbids
 * restating the marks. Nova Micro does not reliably comply — across several
 * revisions it kept returning things like *"All beats are dry"*, *"She did not
 * have the thought"* and *"The second beat is a solid delivery despite the name
 * change, and the fourth beat is empty"*. Each describes the scoring rather than
 * the speech, would read identically for a hundred other blocks, and tells her
 * nothing the pills above it don't.
 *
 * Two rubric revisions failed to stop it, which is the signal to stop asking.
 * The rule is mechanically checkable, so it is checked here instead of hoped
 * for: the model proposes, this disposes. A prompt is the wrong place to
 * enforce a constraint you can evaluate yourself.
 *
 * The test is **groundedness**, not punctuation: does any run of three
 * consecutive words in the note also appear in the speech? That accepts a note
 * that names the place it went wrong even if the model forgot the quote marks,
 * and rejects generic commentary, which by construction shares no phrasing with
 * Shakespeare.
 *
 * Dropping to "" is always safe — `coaching-plan.md` §4 has an empty note as
 * the right answer more often than not. It matters more since §4's pause
 * reversal: the rehearsal now *holds* on a note, so filler costs her seconds of
 * the scene rather than merely being noise.
 */
const NOTE_GROUNDING_SHINGLE = 3;

function groundedNote(note: string, input: CoachBlockInput): string {
  const trimmed = note.trim();
  if (trimmed.length === 0) return "";

  const words = (text: string) =>
    text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(
      Boolean,
    );

  const written = words(input.beats.map((beat) => beat.expected).join(" "))
    .join(
      " ",
    );
  const noteWords = words(trimmed);

  for (let i = 0; i + NOTE_GROUNDING_SHINGLE <= noteWords.length; i++) {
    const shingle = noteWords.slice(i, i + NOTE_GROUNDING_SHINGLE).join(" ");
    if (written.includes(shingle)) return trimmed;
  }

  console.info(
    `Dropped an ungrounded note for block ${input.blockId}: ${
      JSON.stringify(trimmed.slice(0, 80))
    }`,
  );
  return "";
}

/**
 * The prompt body: the speech, beat by beat, with what came back for each.
 *
 * Beats are numbered from 1 in the order given rather than by their stored
 * `beat_number`. Both are usually the same, but `beat_number` is the beat's
 * index *within its block* and nothing guarantees the model gets a contiguous
 * run — CLAUDE.md's warning about that column is about exactly this kind of
 * assumption. A local 1..n is unambiguous and maps back through `input.beats`.
 */
function buildUserMessage(input: CoachBlockInput): string {
  const beats = input.beats
    .map((beat, index) => {
      const heard = beat.heard.trim();
      return [
        `Beat ${index + 1}`,
        `Written: ${beat.expected}`,
        `Heard: ${heard.length > 0 ? heard : "(nothing — she said nothing)"}`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    `Play: ${input.playTitle}`,
    `She is playing: ${input.characterName}`,
    "",
    `This is one speech, in ${input.beats.length} beat(s). Judge each beat.`,
    "",
    beats,
  ].join("\n");
}

interface ModelBeat {
  beatNumber?: number;
  band?: string;
  confidence?: number;
}

interface ModelResponse {
  beats?: ModelBeat[];
  note?: string;
}

/**
 * Map the model's answer back onto the block's beats.
 *
 * Positional by `beatNumber`, and every beat the model failed to return is
 * filled from the deterministic scorer rather than dropped. A missing beat is
 * the one failure that would otherwise be invisible: the block would render
 * with a hole in it and no error anywhere.
 */
function mapBeats(
  input: CoachBlockInput,
  value: ModelResponse,
): BeatCoaching[] {
  const byNumber = new Map<number, ModelBeat>();
  for (const beat of value?.beats ?? []) {
    if (typeof beat?.beatNumber === "number") {
      byNumber.set(beat.beatNumber, beat);
    }
  }

  return input.beats.map((beat, index) => {
    const answered = byNumber.get(index + 1);
    const band = normaliseBand(answered?.band);
    const confidence = normaliseConfidence(answered?.confidence);

    if (band === null || confidence === null) return fallbackBeat(beat);

    // An empty transcript is dry, whatever the model said. It is the one case
    // the rubric can be wrong about in the actor's favour, and the one case
    // where being wrong is unrecoverable: telling her she had a line she never
    // said is worse than any missed note.
    if (beat.heard.trim().length === 0) {
      return { lineId: beat.lineId, confidence: 0, band: "dry" };
    }

    return { lineId: beat.lineId, confidence, band };
  });
}

function normaliseBand(band: unknown): Band | null {
  return band === "solid" || band === "close" || band === "dry" ? band : null;
}

function normaliseConfidence(confidence: unknown): number | null {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return null;
  }
  return Math.min(1, Math.max(0, confidence));
}

/**
 * Word recall standing in for judgement, per beat.
 *
 * Two bands rather than three, on purpose. `score.ts` answers one question —
 * did enough of the written words come back — and that maps onto solid and dry.
 * *Close* is the semantic case ("she had the sense of it, not the words"), which
 * is precisely what word overlap cannot see, so inventing a second cut here
 * would be inventing a distinction the data underneath does not contain.
 */
function fallbackBeat(beat: BeatAttempt): BeatCoaching {
  const score = scoreBeat(beat.expected, beat.heard);
  return {
    lineId: beat.lineId,
    confidence: score.recall,
    band: score.missed ? "dry" : "solid",
  };
}

function fallbackCoaching(input: CoachBlockInput): BlockCoaching {
  return {
    blockId: input.blockId,
    beats: input.beats.map(fallbackBeat),
    // No note. A note is the part that needed a model, and a made-up one from
    // word counts would be the "Great job! Keep practicing!" the rubric exists
    // to prevent.
    note: "",
    source: "fallback",
  };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Coaching timed out after ${ms}ms`)),
      ms,
    );
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
