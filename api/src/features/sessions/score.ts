// How well she said one beat, decided from text alone.
//
// This is `BE_PLAN.md` §5's documented fallback for "Bedrock comparison slow or
// down, fall back to a simpler exact/fuzzy text match so the session isn't
// blocked", built as the real scorer rather than a stub, for three reasons:
//
// 1. It unblocks the session write, which otherwise waits on the fuzzy-match
//    threshold (docs/OPEN_ITEMS.md §1a), the biggest open question in the
//    product, and one that should be settled from real transcripts rather than
//    guessed in advance.
// 2. It produces those transcripts. Every scored beat is an (expected, heard)
//    pair with a number attached, which is exactly the dataset §1a needs.
// 3. The degradation path has to exist anyway, and a fallback that has never run
//    is not a fallback.
//
// Bedrock replaces the *judgement*, not this interface: a semantic comparison
// returns the same BeatScore for the same inputs and everything downstream is
// unchanged. What Bedrock will add is understanding that "I have an eye to tell
// men apart" means the same as "I have an eye to make difference of men's
// liking", which no amount of word overlap can see.

import { toWords, wordsMatch } from "../capture/words.ts";

/**
 * Word recall at or above this counts as said, below it as a miss.
 *
 * This is not the answer to `OPEN_ITEMS.md` §1a, and must not be mistaken for
 * it. 0.7 is a deliberately unopinionated starting point that keeps the ASR
 * floor out of the results: measured word error rate on real Shakespeare is 2.76%
 * (docs/capture-plan.md §2), but it is not evenly spread, the two beats that
 * carried errors lost 10% of their words each. A threshold near 0.9 would fail
 * those beats for Transcribe's mistakes rather than hers.
 *
 * Set it from her actual runs, not from this comment. Recall is recorded on every
 * beat, so the distribution needed to choose properly accumulates by itself.
 */
const SAID_IT_THRESHOLD = 0.7;

export type BeatScore = {
  /** Fraction of the beat's words recovered, 0–1. Stored as
   * `line_mastery.confidence_score`. */
  recall: number;
  /** Whether this counts as a miss worth logging. */
  missed: boolean;
  /** Nothing at all was heard for this beat, she skipped it, or never got to it.
   *
   * Kept separate from a low `recall` on purpose. `OPEN_ITEMS.md` §1a notes that
   * `confidence_score` being continuous makes a near-miss and a total blank read
   * identically in the wrap-up, and they are completely different failures: one
   * means "nearly", the other means "she has no idea". A coach says different
   * things about each. */
  blank: boolean;
  /** Expected words that never turned up, in order. What a note like "you keep
   * dropping 'and yet'" would be built from. */
  missingWords: string[];
};

/**
 * Scores one beat by recall of the expected words, how much of what
 * Shakespeare wrote came back, and deliberately not by precision.
 *
 * Extra words are not penalised. Transcribe inserts them (a cough, the previous
 * character's audio bleeding in), and actors add them: a stumble, a restart, an
 * "um". None of that is failing to know the line. Penalising insertions would
 * mark a correct-but-hesitant delivery as worse than a fluent wrong one, which is
 * backwards for a rehearsal partner.
 *
 * Matching is order-preserving rather than set-based. "him melted have" contains
 * every word of "have melted him" and is not the line; a bag-of-words comparison
 * would call it perfect. Using the same forward-only walk as the beat cursor also
 * keeps the two consistent. See words.ts on why that matters.
 */
export function scoreBeat(expectedText: string, heardText: string): BeatScore {
  const expected = toWords(expectedText);
  const heard = toWords(heardText);

  // A beat with no words is not scoreable. The importer doesn't produce one, so
  // this is a guard rather than a case: treat it as said and move on rather than
  // dividing by zero and recording NaN into the database.
  if (expected.length === 0) {
    return { recall: 1, missed: false, blank: false, missingWords: [] };
  }

  if (heard.length === 0) {
    return {
      recall: 0,
      missed: true,
      blank: true,
      missingWords: [...expected],
    };
  }

  const missingWords: string[] = [];
  let matched = 0;
  let cursor = 0;
  for (const word of expected) {
    // Scan forward for this expected word among what's left of the transcript.
    // Forward-only, so word order has to hold; whatever it skips past is an
    // insertion, which costs nothing.
    let found = -1;
    for (let i = cursor; i < heard.length; i++) {
      if (wordsMatch(heard[i], word)) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      matched++;
      cursor = found + 1;
    } else {
      missingWords.push(word);
    }
  }

  const recall = matched / expected.length;
  return {
    recall,
    missed: recall < SAID_IT_THRESHOLD,
    blank: false,
    missingWords,
  };
}
