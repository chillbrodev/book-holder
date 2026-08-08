// Where in a block she currently is, derived from a growing transcript.
//
// The mic stays open across a whole block and she delivers it at natural pace,
// so nothing in the audio marks a beat boundary for us — beats are scoring
// boundaries, not interaction boundaries (docs/OPEN_ITEMS.md §1b). This module
// is what recovers those boundaries from what she said: given the block's
// expected beat texts and the transcript so far, it answers "which beat is she
// on" and "what did she say for each beat".
//
// It answers the first question so "Line?" can hand over the *next* beat rather
// than the whole speech, and the second so the comparison step downstream has a
// per-beat pair of (expected, heard) to score.
//
// What this deliberately does NOT do is decide whether a beat was said
// *correctly*. That threshold is the biggest open product question in the app
// (docs/OPEN_ITEMS.md §1a) and it belongs with scoring, not with the transport.
// The word tolerance in words.ts exists only to keep the cursor from derailing on
// a transcription wobble; it is not the scoring threshold, and tuning it is not a
// way to tune how strict the coach feels.

import { toWords, wordsMatch } from "./words.ts";

/** How many expected words the alignment may skip over to find a match for the
 * next spoken word — i.e. how many words in a row she can drop before the
 * cursor stops trying to follow her and waits for her to catch up.
 *
 * Four is a phrase, not a line. Wider tolerates bigger cuts but makes a common
 * word ("the", "and") more likely to match spuriously somewhere ahead and drag
 * the cursor forward past text she never said. */
const MAX_SKIPPED_EXPECTED_WORDS = 4;

/** Consecutive spoken words that must line up with consecutive expected words
 * before the cursor is allowed to jump past the local window (see
 * `findResyncPoint`).
 *
 * Three is the smallest run that isn't routinely produced by chance: single
 * common words collide constantly across a 150-character beat, pairs like "of
 * the" and "I have" recur within one speech, but three consecutive matching
 * words is almost always the text itself. */
const RESYNC_RUN_LENGTH = 3;

export type BeatProgress = {
  /** Index into the block's beats she is believed to be delivering now.
   * Equals `beats.length` once the whole block has been accounted for. */
  beatIndex: number;
  /** Beats the cursor has moved past. Note "passed", not "said correctly" — a
   * beat she skipped outright counts here too, because she is no longer on it.
   * Its `heardByBeat` entry is empty, which is how a skip is told apart from a
   * near-miss downstream. */
  beatsCompleted: number;
  /** What she said, split per beat. Index-aligned with the block's beats, so
   * `heardByBeat[i]` pairs with `beats[i]` for the comparison step. Beats she
   * hasn't reached are empty strings. */
  heardByBeat: string[];
  /** Fraction of the current beat's words matched so far, 0–1. Drives the
   * "she's mid-thought" affordances; not a score. */
  progressThroughBeat: number;
};

/**
 * Aligns a transcript against a block's beats and reports how far through it she
 * is.
 *
 * Recomputed from the whole transcript on every update rather than advanced
 * incrementally, because a streaming partial is a *revision*: the tail of what
 * Transcribe said a moment ago can change on the next event. Incremental state
 * built on a partial that then gets rewritten is state that quietly disagrees
 * with the audio. A block is at most a few hundred words, so re-aligning costs
 * nothing worth saving.
 *
 * The alignment is monotonic — the expected-word pointer only ever moves
 * forward. That is not an optimization either, it is the only thing that makes
 * repeated text survivable: "How shall I be revenged on him?" is beat 6 of one
 * Mistress Ford block in II.i and beat 13 of a Mistress Page block in the same
 * scene, and within a single block a phrase can recur too. A best-match search
 * over the whole block would let a repeat pull the cursor backwards; a forward
 * pointer cannot.
 *
 * Callers keeping a cursor across updates should clamp it non-decreasing
 * themselves — see CaptureSession. This function is pure and will happily report
 * a lower beat index if a revised partial genuinely retracts words.
 */
export function alignToBeats(
  beats: readonly string[],
  transcript: string,
): BeatProgress {
  // Flat list of expected words, each tagged with the beat it came from, so a
  // position in the alignment maps straight back to a beat index.
  const expected: { word: string; beat: number }[] = [];
  beats.forEach((beat, index) => {
    for (const word of toWords(beat)) expected.push({ word, beat: index });
  });

  const heardByBeat: string[][] = beats.map(() => []);
  const spoken = toWords(transcript);

  /**
   * Where, further ahead than the local window, the next few spoken words line
   * up with the text — or -1 if nowhere convincing.
   *
   * This exists for the mistake the local window cannot absorb: she skips a
   * whole beat. Forgetting a thought and carrying on with the next one is a
   * normal rehearsal failure, and it moves her dozens of words past the cursor
   * at once. Without a resync the cursor would stall on the abandoned beat for
   * the rest of the speech and attribute everything she went on to say to it —
   * so a single skipped thought would be reported as every following beat being
   * wrong too.
   *
   * A jump needs `RESYNC_RUN_LENGTH` consecutive words to agree, rather than
   * one, because a single-word match anywhere in a long block proves nothing.
   * Forward-only, like the main pointer: resyncing is how she gets *past* a
   * skipped beat, never how a repeated phrase drags her back into one.
   */
  function findResyncPoint(spokenFrom: number, searchFrom: number): number {
    if (spokenFrom + RESYNC_RUN_LENGTH > spoken.length) return -1;
    const runEnd = Math.min(
      expected.length - RESYNC_RUN_LENGTH,
      expected.length,
    );
    for (let candidate = searchFrom; candidate <= runEnd; candidate++) {
      let matched = true;
      for (let offset = 0; offset < RESYNC_RUN_LENGTH; offset++) {
        if (
          !wordsMatch(
            spoken[spokenFrom + offset],
            expected[candidate + offset].word,
          )
        ) {
          matched = false;
          break;
        }
      }
      if (matched) return candidate;
    }
    return -1;
  }

  let consumed = 0;
  let index = 0;
  while (index < spoken.length) {
    const word = spoken[index];
    const windowEnd = Math.min(
      consumed + 1 + MAX_SKIPPED_EXPECTED_WORDS,
      expected.length,
    );
    let matchedAt = -1;
    for (let candidate = consumed; candidate < windowEnd; candidate++) {
      if (wordsMatch(word, expected[candidate].word)) {
        matchedAt = candidate;
        break;
      }
    }

    if (matchedAt >= 0) {
      // Attribute to the beat the matched *expected* word belongs to, not to
      // wherever the cursor happened to be — that is what keeps the split
      // correct when she runs two beats together in one breath.
      heardByBeat[expected[matchedAt].beat].push(word);
      consumed = matchedAt + 1;
      index++;
      continue;
    }

    // Nothing nearby. Before writing this off as a stumble, check whether she
    // has actually moved on to a later part of the speech.
    const resyncAt = findResyncPoint(index, windowEnd);
    if (resyncAt >= 0) {
      consumed = resyncAt;
      // Deliberately does not advance `index`: the next pass round the loop
      // matches this same word at the new position, so it gets attributed to the
      // beat it belongs to rather than being spent on the jump.
      continue;
    }

    // A mishearing, a stumble, or something she added. It still belongs to the
    // beat she is on — the comparison step needs to see it, since a wrong word
    // is precisely what it is looking for.
    const currentBeat = consumed < expected.length
      ? expected[consumed].beat
      : beats.length - 1;
    if (currentBeat >= 0) heardByBeat[currentBeat].push(word);
    index++;
  }

  const beatIndex = consumed < expected.length
    ? expected[consumed].beat
    : beats.length;

  let beatsCompleted = 0;
  for (let beat = 0; beat < beats.length; beat++) {
    const lastWordOfBeat = expected.findLastIndex((e) => e.beat === beat);
    // A beat with no words at all (defensive — the importer doesn't produce
    // one) can't be "reached", so it never blocks completion.
    if (lastWordOfBeat === -1 || lastWordOfBeat < consumed) beatsCompleted++;
    else break;
  }

  const currentBeatWords = beatIndex < beats.length
    ? expected.filter((e) => e.beat === beatIndex).length
    : 0;
  const consumedInCurrentBeat = beatIndex < beats.length
    ? consumed - expected.findIndex((e) => e.beat === beatIndex)
    : 0;

  return {
    beatIndex,
    beatsCompleted,
    heardByBeat: heardByBeat.map((words) => words.join(" ")),
    progressThroughBeat: currentBeatWords > 0
      ? Math.max(0, Math.min(1, consumedInCurrentBeat / currentBeatWords))
      : beatIndex >= beats.length
      ? 1
      : 0,
  };
}
