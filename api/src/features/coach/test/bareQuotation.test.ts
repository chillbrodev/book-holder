// The echo filter, against the note that actually shipped.
//
// A stored `coach_recommendation` for a real session read, in its entirety, as
// Fenton's own speech — the agent performed step 1 of the brief's three-step
// note and stopped. `unwrap` then removed the surrounding quotation marks, so
// the wrap-up rendered a copy of her script under "From the Book Holder".
//
// Pinned here rather than argued in the prompt, following `groundedNote` in
// features/coaching: three rubric revisions failed to stop Nova emitting "All
// beats are dry", and the fix that worked was a mechanical check. The rule is
// mechanically checkable, so it is checked.
//
// The other half of these cases matter just as much: a *good* note also quotes
// the line, so a filter that fires on "contains a quoted line" would reject
// every note worth keeping.
import { assert, assertFalse } from "@std/assert";
import { isBareQuotation } from "../service.ts";

const LINE =
  "From time to time I have acquainted you With the dear love I bear to fair Anne Page; Who mutually hath answer'd my affection,";
const OTHER_LINE =
  "I have a letter from her Of such contents as you will wonder at; The mirth whereof so larded with my matter,";
const PLAY = [LINE, OTHER_LINE];

Deno.test("the note that actually shipped is rejected", () => {
  assert(isBareQuotation(LINE, PLAY));
});

Deno.test("punctuation and casing don't let an echo through", () => {
  // The model re-punctuates freely; matching on the raw string would miss this.
  assert(isBareQuotation(
    "from time to time i have acquainted you with the dear love i bear to fair anne page who mutually hath answerd my affection",
    PLAY,
  ));
});

Deno.test("a quoted line with a label stuck on it is still an echo", () => {
  // Three words is a caption, not something to act on.
  assert(isBareQuotation(`"${LINE}" — dry again.`, PLAY));
});

Deno.test("an empty note is rejected", () => {
  assert(isBareQuotation("   ", PLAY));
});

Deno.test("a real note quoting the line is kept", () => {
  // The shape the brief asks for: the line, what keeps happening to it, what to
  // do about it. This must survive, or the filter has eaten the feature.
  assertFalse(isBareQuotation(
    `"${LINE}" has gone dry three runs in a row, and each time you've come in on "the dear love" and lost the rest. Take that speech on its own before you run the scene again.`,
    PLAY,
  ));
});

Deno.test("a note quoting a different line is kept", () => {
  assertFalse(isBareQuotation(
    `You've dropped "${OTHER_LINE}" twice now — run it slowly until the turn at "wonder at" stops surprising you.`,
    PLAY,
  ));
});

Deno.test("a note naming a scene rather than quoting is kept", () => {
  // The fallback the brief allows when get_recent_misses comes back empty.
  assertFalse(isBareQuotation(
    "You've never run Act III, Scene iv all the way to the end. Start there tomorrow.",
    PLAY,
  ));
});
