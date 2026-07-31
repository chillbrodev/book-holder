// Segmentation rules — see docs/beats-and-blocks-plan.md §3.
//
// A speech's verse/prose lines are typographic wrapping, not units of meaning.
// These functions turn them into *beats*: one thought each, which is what the
// coach scores, what "Line?" prompts with, and what line_mastery keys on.
//
// Pure and offline on purpose — no DB, no AWS, no randomness — so the rules can
// be re-run over the whole corpus and diffed.

/** Above this, a sentence is clause-split at `;`/`:`. A target, not a
 * guarantee: ~0.5-0.7% of beats exceed it because the sentence has no internal
 * clause punctuation, and one unbroken thought is left whole rather than cut at
 * a comma to hit a number. */
const MAX_BEAT_CHARS = 200;

/** A fragment shorter than this that ends in `!` is an interjection and merges
 * forward. Ending in `.`/`?` it does not — see mergeInterjections. */
const INTERJECTION_MAX_CHARS = 40;

/** Sentence end: terminal punctuation plus any closing quotes/brackets. No
 * abbreviation defense — the Shakespeare corpus has no "Mr."/"Mrs."/"St.". */
const SENTENCE_BOUNDARY = /(?<=[.!?]["'’)\]]*)\s+/;
const CLAUSE_BOUNDARY = /(?<=[;:])\s+/;
const ENDS_EXCLAIMING = /!["'’)\]]*$/;

/** Where each source line's text landed in the joined string, so a beat can be
 * mapped back to the verse lines it spans (LineRow.source_lines). */
export interface JoinedSpeech {
  text: string;
  lineRanges: Array<{ start: number; end: number }>;
}

/**
 * Joins the lines of one speech into a single text.
 *
 * Single space, except when a compound was broken across the line break: a line
 * ending in letter + `-` whose successor starts lowercase is rejoined with no
 * space at all ("Star-" + "chamber" -> "Star-chamber"). Without this, Polly
 * reads "Star- chamber" as two words.
 *
 * The hyphen is *kept*, not swallowed. Every occurrence in the corpus so far is
 * a genuinely hyphenated word that Moby happened to break at its own hyphen
 * (Star-chamber, note-book, holiday-time), not a typesetter's mid-word break.
 *
 * The lowercase test is what keeps it honest — "...to whose falls-" followed by
 * "Heaven prosper the right!" is a dash, not a broken word, and stays split.
 * `--` (interruption) is never joined.
 */
export function joinVerseLines(texts: string[]): JoinedSpeech {
  let text = "";
  const lineRanges: Array<{ start: number; end: number }> = [];

  for (const raw of texts) {
    if (text === "") {
      lineRanges.push({ start: 0, end: raw.length });
      text = raw;
      continue;
    }

    const brokenWord = /[A-Za-z]-$/.test(text) && !/--$/.test(text) && /^[a-z]/.test(raw);
    if (brokenWord) {
      lineRanges.push({ start: text.length, end: text.length + raw.length });
      text += raw;
    } else {
      const start = text.length + 1; // the separating space
      lineRanges.push({ start, end: start + raw.length });
      text += ` ${raw}`;
    }
  }

  return { text, lineRanges };
}

/** Short exclamations and addresses belong with what follows them; short
 * *statements* and *questions* are their own thought and must stay separate, or
 * a coaching note can't name which one she fumbled.
 *
 *   merged:  "Ha! o' my life, if I were young again, the sword should end it."
 *   kept:    "Well, let us see honest Master Page." | "Is Falstaff there?"
 *
 * The naive form of this rule (merge any short fragment forward) fired 340
 * times in Merry Wives and mostly glued two distinct thoughts together. */
function mergeInterjections(sentences: string[]): string[] {
  const merged: string[] = [];
  for (const sentence of sentences) {
    const previous = merged[merged.length - 1];
    const absorbs = previous !== undefined &&
      previous.length < INTERJECTION_MAX_CHARS &&
      ENDS_EXCLAIMING.test(previous) &&
      previous.length + 1 + sentence.length <= MAX_BEAT_CHARS;

    if (absorbs) merged[merged.length - 1] = `${previous} ${sentence}`;
    else merged.push(sentence);
  }
  return merged;
}

/** Splits an over-long sentence at `;`/`:`, accumulating clauses greedily
 * rather than splitting at every one — Shakespeare's colons and semicolons are
 * rhetorical turns, so these land where an actor breathes. A sentence with no
 * clause punctuation comes back whole and over the ceiling, deliberately. */
function splitLongSentence(sentence: string): string[] {
  if (sentence.length <= MAX_BEAT_CHARS) return [sentence];

  const out: string[] = [];
  let current = "";
  for (const clause of sentence.split(CLAUSE_BOUNDARY)) {
    if (current && current.length + 1 + clause.length > MAX_BEAT_CHARS) {
      out.push(current);
      current = clause;
    } else {
      current = current ? `${current} ${clause}` : clause;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Splits one joined speech-block into beats.
 *
 * Every returned beat is an exact substring of `text` (splits only ever drop a
 * single separating space, and merges restore exactly that space), which is
 * what lets buildRows map beats back onto source lines by offset.
 */
export function splitIntoBeats(text: string): string[] {
  if (text.trim() === "") return [];
  const sentences = text.split(SENTENCE_BOUNDARY);
  return mergeInterjections(sentences).flatMap(splitLongSentence);
}

export const SEGMENT_LIMITS = { MAX_BEAT_CHARS, INTERJECTION_MAX_CHARS };
