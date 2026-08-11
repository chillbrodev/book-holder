/**
 * What the coach says about one block, and about each beat inside it.
 *
 * Shapes only — the judgement is in `service.ts` and the wording of the rubric
 * is in `rubric.ts`. Kept separate because the capture socket, the session
 * writer and the wrap-up all need these types without needing Bedrock.
 */

/**
 * How she did on one beat, in the language `docs/coaching-plan.md` §3 settled
 * on: *solid* / *close* / *dry*. Never a percentage — the style guide's voice is
 * backstage crew, not a teacher, and "dry" is what someone in the wings would
 * actually say about a forgotten line.
 */
export type Band = "solid" | "close" | "dry";

export interface BeatCoaching {
  lineId: string;
  /**
   * Continuous, 0–1. Stored as `session_beat_score.confidence_score` and as
   * `line_mastery.confidence_score`, exactly as the deterministic scorer's
   * recall was — everything downstream of those columns is unchanged.
   */
  confidence: number;
  band: Band;
}

export interface BlockCoaching {
  blockId: string;
  beats: BeatCoaching[];
  /**
   * One short note for the whole speech, or empty when there is nothing worth
   * saying. Per block rather than per beat because a note is about the delivery
   * of a speech; `docs/coaching-plan.md` §6 keeps it in its own table for the
   * same reason.
   */
  note: string;
  /**
   * Which judgement this is. `fallback` means Bedrock was slow, down, or
   * refused and `score.ts`'s word-recall stood in — the scene is never blocked
   * on the model (`BE_PLAN.md` §5). Worth carrying to the client so a demo can
   * tell the two apart, and worth logging so a silent slide onto the fallback
   * doesn't look like working coaching.
   */
  source: "bedrock" | "fallback";
}
