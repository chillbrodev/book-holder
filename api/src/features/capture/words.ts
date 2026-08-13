// Comparing a spoken word to a written one, in the one place that decides it.
//
// Shared by the beat cursor, which uses it to follow her through a block, and by
// scoring, which uses it to judge what she said. Those two must agree: a beat
// scored under different normalization than it was aligned with would disagree
// with itself, attributing words to a beat and then calling them absent from it.
//
// Nothing here is the fuzzy-match threshold (docs/OPEN_ITEMS.md §1a). This is
// word *identity*, "is this the same word", and the tolerance exists because
// Transcribe and a 400-year-old printed text spell the same spoken word
// differently. How many correct words make a correct beat is a separate question,
// decided in score.ts.

/** Words at least this long may match with one character of edit distance.
 * Shorter words are compared exactly, at three characters an edit-distance of
 * one makes "a"/"I", "the"/"thee" and "no"/"so" interchangeable, which is a
 * worse failure than missing a genuine mishearing. */
const MIN_LENGTH_FOR_FUZZY_MATCH = 4;

/**
 * Comparison form of a word: lowercase, apostrophes removed, punctuation gone.
 *
 * Apostrophes are dropped rather than kept because Shakespeare's elisions are
 * exactly where the source text and a transcript disagree without anybody being
 * wrong, the Moby text writes "'scaped" and "reveng'd" where Transcribe will
 * write "scaped" and "revenged". Removing the apostrophe makes the first pair
 * identical and the second one character apart, which the tolerance below covers.
 */
export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Splits text into comparable words, treating a hyphen as a word boundary.
 *
 * The hyphen split is load-bearing, not tidying. A printed hyphen is typography;
 * she says two words, and Transcribe writes two words. Without splitting,
 * "well-behaved" normalizes to the single token "wellbehaved", which can never
 * match "well behaved" at any edit distance, so every hyphenated compound was a
 * guaranteed miss. The Moby text is full of them ("love-letters",
 * "holiday-time", "soldier-like", "well-nigh"), and it also uses "--" as a dash
 * mid-sentence, which this handles for free.
 *
 * Caught by a scoring test rather than by reading the code: "and gave such
 * orderly and well-behaved reproof" scored 0.9 against a transcript that had
 * every word of it.
 */
export function toWords(text: string): string[] {
  return text
    .split(/[\s\-‐-―]+/)
    .map(normalizeWord)
    .filter((word) => word.length > 0);
}

/** Levenshtein distance, abandoned as soon as it exceeds `limit`.
 *
 * The early exit is not just an optimization: it means the cost is bounded by
 * the limit rather than by word length, which matters because this runs over
 * every spoken word against a small window of expected words on every partial
 * result, and partials arrive several times a second. */
export function withinEditDistance(
  a: string,
  b: string,
  limit: number,
): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMinimum = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
      rowMinimum = Math.min(rowMinimum, current[j]);
    }
    // Every subsequent row is >= this row's minimum, so once the whole row is
    // past the limit the final distance cannot come back under it.
    if (rowMinimum > limit) return false;
    previous = current;
  }
  return previous[b.length] <= limit;
}

/** Whether a transcribed word and a written word are the same word.
 *
 * Deliberately not symmetric in intent even though it is in implementation: the
 * first argument is what a machine heard, the second what Shakespeare wrote. That
 * asymmetry is why the tolerance is one edit and not two, "threw"/"through" is
 * two edits and genuinely different words, and letting it match would hide a real
 * mishearing (measured: docs/capture-plan.md §8). */
export function wordsMatch(spoken: string, expected: string): boolean {
  if (spoken === expected) return true;
  const fuzzyAllowed = spoken.length >= MIN_LENGTH_FOR_FUZZY_MATCH &&
    expected.length >= MIN_LENGTH_FOR_FUZZY_MATCH;
  return fuzzyAllowed && withinEditDistance(spoken, expected, 1);
}
