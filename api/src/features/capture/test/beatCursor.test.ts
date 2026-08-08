import { assertEquals, assertGreater } from "@std/assert";
import { alignToBeats } from "../beatCursor.ts";

// Mistress Ford's 8-beat block from Merry Wives II.i — the real text, verified
// against the database (block 8d8add6e-ece5-5649-a845-65b085993bdd). Used rather
// than invented lines because the things that make alignment hard here are
// properties of the actual corpus: elisions, a repeated question, and beats that
// run to 150 characters.
//
// Copied in rather than read from a fixture file on purpose. A fixture checked in
// beside the code it feeds has no mechanism telling it when the importer's rules
// change, and the last one silently went two years' worth of segmentation stale
// (docs/OPEN_ITEMS.md §3). These strings are asserted against nothing but
// themselves; the block id above is how to re-check them.
const MISTRESS_FORD_BLOCK = [
  "We burn daylight: here, read, read; perceive how I might be knighted.",
  "I shall think the worse of fat men, as long as I have an eye to make difference of men's liking: and yet he would not swear; praised women's modesty;",
  "and gave such orderly and well-behaved reproof to all uncomeliness, that I would have sworn his disposition would have gone to the truth of his words;",
  "but they do no more adhere and keep place together than the Hundredth Psalm to the tune of 'Green Sleeves.'",
  "What tempest, I trow, threw this whale, with so many tuns of oil in his belly, ashore at Windsor?",
  "How shall I be revenged on him?",
  "I think the best way were to entertain him with hope, till the wicked fire of lust have melted him in his own grease.",
  "Did you ever hear the like?",
];

Deno.test("nothing said yet leaves the cursor on the first beat", () => {
  const progress = alignToBeats(MISTRESS_FORD_BLOCK, "");
  assertEquals(progress.beatIndex, 0);
  assertEquals(progress.beatsCompleted, 0);
  assertEquals(progress.progressThroughBeat, 0);
  assertEquals(progress.heardByBeat.every((heard) => heard === ""), true);
});

Deno.test("mid-beat delivery reports the beat she is on, not the next one", () => {
  const progress = alignToBeats(
    MISTRESS_FORD_BLOCK,
    "We burn daylight here read",
  );
  assertEquals(progress.beatIndex, 0);
  assertEquals(progress.beatsCompleted, 0);
  assertGreater(progress.progressThroughBeat, 0);
});

Deno.test("finishing a beat completes it and moves to the next", () => {
  const progress = alignToBeats(
    MISTRESS_FORD_BLOCK,
    "We burn daylight here read read perceive how I might be knighted",
  );
  assertEquals(progress.beatsCompleted, 1);
  assertEquals(progress.beatIndex, 1);
});

Deno.test("beats run together in one breath still split per beat", () => {
  // She delivers beats 1 and 2 continuously, which is the normal case — there is
  // no pause in the audio for the boundary to be recovered from.
  const progress = alignToBeats(
    MISTRESS_FORD_BLOCK,
    "We burn daylight here read read perceive how I might be knighted " +
      "I shall think the worse of fat men as long as I have an eye",
  );
  assertEquals(progress.beatIndex, 1);
  assertEquals(progress.beatsCompleted, 1);
  assertEquals(
    progress.heardByBeat[0],
    "we burn daylight here read read perceive how i might be knighted",
  );
  assertEquals(
    progress.heardByBeat[1],
    "i shall think the worse of fat men as long as i have an eye",
  );
});

Deno.test("a dropped article does not stall the cursor", () => {
  // "a dropped 'the'" is the canonical near-miss (docs/OPEN_ITEMS.md §1a). The
  // cursor must follow her through it; whether it *counts* as a miss is decided
  // downstream, not here.
  const progress = alignToBeats(
    MISTRESS_FORD_BLOCK,
    "We burn daylight here read read perceive how I might be knighted " +
      "I shall think worse of fat men",
  );
  assertEquals(progress.beatIndex, 1);
  assertGreater(progress.progressThroughBeat, 0.2);
});

Deno.test("an elided source word matches its transcribed spelling", () => {
  // The source writes 'Green Sleeves' with an apostrophe and "well-behaved" with
  // a hyphen; a transcript has neither.
  const progress = alignToBeats(
    MISTRESS_FORD_BLOCK,
    "and gave such orderly and well behaved reproof to all uncomeliness",
  );
  // Beat 2 (index 2) is where those words live — she skipped straight to it,
  // and the monotonic pointer follows because nothing earlier matched.
  assertEquals(progress.beatIndex, 2);
  assertGreater(progress.progressThroughBeat, 0);
});

Deno.test("a repeated question cannot pull the cursor backwards", () => {
  // "How shall I be revenged on him?" is beat 5 here (and beat 12 of Mistress
  // Page's block in the same scene). Saying it again while she is on beat 6 must
  // not rewind the cursor to 5.
  const throughBeatSix = alignToBeats(
    MISTRESS_FORD_BLOCK,
    "How shall I be revenged on him I think the best way were to entertain him",
  );
  assertEquals(throughBeatSix.beatIndex, 6);

  const repeated = alignToBeats(
    MISTRESS_FORD_BLOCK,
    "How shall I be revenged on him I think the best way were to entertain him " +
      "how shall I be revenged on him",
  );
  assertGreater(repeated.beatIndex, 5);
});

Deno.test("a mishearing is attributed to the beat she is on", () => {
  // "tuns of oil" is likely to come back as "tons of oil"; "trow" as "throw".
  // Either way the words belong to beat 4 so the comparison step can see them.
  const progress = alignToBeats(
    MISTRESS_FORD_BLOCK,
    "What tempest I throw threw this whale with so many tons of oil in his belly ashore at Windsor",
  );
  assertEquals(progress.heardByBeat[4].includes("windsor"), true);
  assertEquals(progress.beatsCompleted, 5);
});

Deno.test("the whole block delivered completes every beat", () => {
  const progress = alignToBeats(
    MISTRESS_FORD_BLOCK,
    MISTRESS_FORD_BLOCK.join(" "),
  );
  assertEquals(progress.beatsCompleted, MISTRESS_FORD_BLOCK.length);
  assertEquals(progress.beatIndex, MISTRESS_FORD_BLOCK.length);
  assertEquals(progress.progressThroughBeat, 1);
  // Every beat got words attributed to it — nothing collapsed into a neighbour.
  assertEquals(progress.heardByBeat.every((heard) => heard.length > 0), true);
});

Deno.test("a skipped beat is recovered from, not stalled on", () => {
  // She delivers beat 0, forgets beat 1 entirely, and carries on with beat 2.
  // The cursor has to follow her — stalling on beat 1 would attribute the whole
  // rest of the speech to it and report every later beat as wrong too.
  const progress = alignToBeats(
    MISTRESS_FORD_BLOCK,
    "We burn daylight here read read perceive how I might be knighted " +
      "and gave such orderly and well behaved reproof to all uncomeliness " +
      "that I would have sworn his disposition",
  );
  assertEquals(progress.beatIndex, 2);
  assertEquals(progress.heardByBeat[0].startsWith("we burn daylight"), true);
  // The skipped beat shows as nothing heard, which is exactly the signal the
  // comparison step needs: a blank, not a near-miss.
  assertEquals(progress.heardByBeat[1], "");
  assertEquals(
    progress.heardByBeat[2].startsWith("and gave such orderly"),
    true,
  );
});

Deno.test("resync needs a real run of words, not one lucky match", () => {
  // "the" appears in most beats of this block. A single common word must not be
  // enough to throw the cursor to the far end of the speech.
  const progress = alignToBeats(MISTRESS_FORD_BLOCK, "we burn the");
  assertEquals(progress.beatIndex, 0);
});

Deno.test("a one-beat block behaves like any other", () => {
  const progress = alignToBeats(["Adieu."], "adieu");
  assertEquals(progress.beatsCompleted, 1);
  assertEquals(progress.beatIndex, 1);
});

Deno.test("unrelated speech leaves the cursor where it was", () => {
  // Someone else's line bleeding in, or a cough transcribed as words. The cursor
  // must not advance on text that matches nothing.
  const progress = alignToBeats(
    MISTRESS_FORD_BLOCK,
    "sorry what was that can you say it again",
  );
  assertEquals(progress.beatIndex, 0);
  assertEquals(progress.beatsCompleted, 0);
});
