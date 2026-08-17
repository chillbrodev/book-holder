// The rationale is shown to the actor as evidence — "two of its nine beats are
// dry" — so a wrong number is a confident false claim about her own rehearsal,
// which is worse than saying nothing.
//
// It went wrong on the first real run: the tool description carried an example
// sentence, and Nova Lite shipped its numbers verbatim, reporting two of nine
// beats dry when the truth was one of eleven. Verified against the live tally at
// the time. Third instance in this codebase of the same lesson — after
// `groundedNote` and `isBareQuotation` — that a rule a machine can check should
// be checked rather than argued for in a prompt.
import { assert, assertEquals, assertFalse } from "@std/assert";
import { composeRationale, rationaleMatchesMarks } from "../service.ts";

// The real shape of Fenton's IV.vi speech at the time of the failure.
const TALLY = { beats: 11, solid: 2, close: 8, dry: 1 };

Deno.test("the sentence that actually shipped is rejected", () => {
  assertFalse(
    rationaleMatchesMarks(
      "Two of its nine beats are dry and four more are close.",
      TALLY,
    ),
  );
});

Deno.test("numbers written as words are read, not skipped", () => {
  // The model writes "eleven", not "11". A digits-only check would have passed
  // the failing sentence above.
  assert(
    rationaleMatchesMarks(
      "One of its eleven beats is dry, eight are close.",
      TALLY,
    ),
  );
});

Deno.test("digits are read too", () => {
  assert(rationaleMatchesMarks("1 dry, 8 close, across 11 beats.", TALLY));
});

Deno.test("one invented number spoils the whole sentence", () => {
  // 8 and 11 are hers; 5 is not. Partial truth is still a false claim.
  assertFalse(rationaleMatchesMarks("8 close and 5 dry of 11 beats.", TALLY));
});

Deno.test("a rationale with no numbers is not evidence", () => {
  // It may be perfectly true, but the field exists to carry counts; without one
  // it is just more advice, and the note already carries that.
  assertFalse(
    rationaleMatchesMarks("This speech keeps letting you down.", TALLY),
  );
});

Deno.test("composed fallback states only what is true", () => {
  assertEquals(
    composeRationale(TALLY),
    "Of its 11 beats: 1 dry, 8 close, 2 solid.",
  );
});

Deno.test("composed fallback omits bands with no beats in them", () => {
  assertEquals(
    composeRationale({ beats: 3, solid: 3, close: 0, dry: 0 }),
    "Of its 3 beats: 3 solid.",
  );
});

Deno.test("composed fallback is empty when nothing has been judged", () => {
  // Every beat scored by the deterministic fallback only, so no band anywhere.
  // Saying "of its 4 beats:" and then nothing would read as a rendering fault.
  assertEquals(composeRationale({ beats: 4, solid: 0, close: 0, dry: 0 }), "");
});

Deno.test("a single beat is not pluralised", () => {
  assertEquals(
    composeRationale({ beats: 1, solid: 0, close: 0, dry: 1 }),
    "Of its 1 beat: 1 dry.",
  );
});
