// Block-level helpers shared by buildRows (which assigns is_verse) and render
// (which prints blocks). See docs/beats-and-blocks-plan.md §2.

import type { LineRow } from "./types.js";

/** A block reads as verse when this share of its continuation lines start with
 * a capital. Validated against ground truth: Richard II, written entirely in
 * verse, scores 98%; prose-heavy Merry Wives scores 17%; mixed As You Like It,
 * 40%. */
const VERSE_CAPITAL_RATIO = 0.8;

export function groupIntoBlocks(lines: LineRow[]): LineRow[][] {
  const blocks = new Map<string, LineRow[]>();
  for (const line of lines) {
    const beats = blocks.get(line.block_id) ?? [];
    beats.push(line);
    blocks.set(line.block_id, beats);
  }
  return [...blocks.values()];
}

/**
 * A block's verse lines, each exactly once, in order, what a verse display
 * renders.
 *
 * Beats carry the lines they *span*, so when a beat boundary falls mid-line
 * that line is the last entry of one beat and the first of the next.
 * `shares_first_source_line` marks exactly that. See the field's note on why
 * comparing the text instead would break on song refrains.
 */
export function blockVerseLines(beats: LineRow[]): string[] {
  return beats.flatMap((beat) =>
    beat.shares_first_source_line ? beat.source_lines.slice(1) : beat.source_lines
  );
}

/**
 * Whether a block is verse, or `null` when it can't be told.
 *
 * Moby records no verse/prose marker, so this reads the lineation itself: verse
 * capitalizes every line because every line is a line of poetry, while prose is
 * wrapped to a fixed measure and its continuations start mid-sentence in
 * lowercase.
 *
 * A one-line block carries no continuation to judge, hence `null`, resolved by
 * the play's dominant mode in assignVerseFlags, since a one-line speech in an
 * all-verse play is still verse.
 */
export function detectVerse(verseLines: string[]): boolean | null {
  const continuations = verseLines.slice(1);
  if (continuations.length === 0) return null;
  const capitalized = continuations.filter((line) => /^[A-Z]/.test(line)).length;
  return capitalized / continuations.length >= VERSE_CAPITAL_RATIO;
}

/**
 * Sets `is_verse` on every row, in place.
 *
 * A one-line block carries no lineation to read, and there are a lot of them,
 * half of Richard II's blocks, and it is an all-verse play, so defaulting them
 * to prose would be wrong far more often than not. They inherit their
 * scene's dominant mode: Shakespeare switches between verse and prose at
 * scene and character boundaries, not line by line, so the surrounding scene is
 * a much better witness than the play. A scene with nothing decidable in it
 * falls back to the play.
 */
export function assignVerseFlags(lines: LineRow[]): void {
  const blocks = groupIntoBlocks(lines);
  const verdicts = blocks.map((beats) => detectVerse(blockVerseLines(beats)));
  const sceneKey = (beats: LineRow[]) => `${beats[0].act_order}|${beats[0].scene_order}`;

  const tally = (keys: (boolean | null)[]) => {
    const decided = keys.filter((v) => v !== null) as boolean[];
    return decided.length === 0
      ? null
      : decided.filter(Boolean).length / decided.length >= 0.5;
  };

  const playDominant = tally(verdicts) ?? false;
  const byScene = new Map<string, (boolean | null)[]>();
  blocks.forEach((beats, i) => {
    const key = sceneKey(beats);
    const list = byScene.get(key) ?? [];
    list.push(verdicts[i]);
    byScene.set(key, list);
  });
  const sceneDominant = new Map(
    [...byScene.entries()].map(([key, list]) => [key, tally(list) ?? playDominant])
  );

  blocks.forEach((beats, i) => {
    const isVerse = verdicts[i] ?? sceneDominant.get(sceneKey(beats)) ?? playDominant;
    for (const beat of beats) beat.is_verse = isVerse;
  });
}
