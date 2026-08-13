import {
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertLess,
} from "@std/assert";
import { scoreBeat } from "../score.ts";

Deno.test("a perfect delivery scores 1 and is not a miss", () => {
  const beat = "How shall I be revenged on him?";
  const score = scoreBeat(beat, "how shall i be revenged on him");
  assertEquals(score.recall, 1);
  assertEquals(score.missed, false);
  assertEquals(score.blank, false);
  assertEquals(score.missingWords, []);
});

Deno.test("nothing heard is blank, not merely a low score", () => {
  // A skipped beat and a fumbled one are different failures and a coach says
  // different things about them (docs/OPEN_ITEMS.md §1a).
  const score = scoreBeat("How shall I be revenged on him?", "");
  assertEquals(score.blank, true);
  assertEquals(score.missed, true);
  assertEquals(score.recall, 0);
  assertEquals(score.missingWords.length, 7);
});

Deno.test("the real Slender line survives its transcription", () => {
  // From an actual run: "Ay, cousin Slender, and 'Custalourum" came back as
  // "I, Cousin Slender, and Castellorum". She said it. Transcribe couldn't spell
  // it. 3 of 5 words recover, "ay" is under the fuzzy floor and "custalourum" is
  // four edits from "castellorum", so this lands as a miss, and that is the
  // honest result of a text-only comparison rather than a bug.
  const score = scoreBeat(
    "Ay, cousin Slender, and 'Custalourum.",
    "I, Cousin Slender, and Castellorum.",
  );
  assertAlmostEquals(score.recall, 3 / 5, 0.01);
  assertEquals(score.blank, false);
  assertEquals(score.missingWords, ["ay", "custalourum"]);
});

Deno.test("a dropped article is a near miss, not a blank", () => {
  const beat = "I shall think the worse of fat men, as long as I have an eye";
  const score = scoreBeat(
    beat,
    "i shall think worse of fat men as long as i have an eye",
  );
  assertGreater(score.recall, 0.9);
  assertEquals(score.missed, false);
  assertEquals(score.missingWords, ["the"]);
});

Deno.test("elisions and hyphens don't count against her", () => {
  // The source writes "well-behaved" and "'Green Sleeves'"; a transcript has
  // neither the hyphen nor the apostrophes.
  const score = scoreBeat(
    "and gave such orderly and well-behaved reproof to all uncomeliness",
    "and gave such orderly and well behaved reproof to all uncomeliness",
  );
  assertEquals(score.recall, 1);
  assertEquals(score.missingWords, []);
});

Deno.test("extra words cost nothing", () => {
  // A stumble, a restart, a cough transcribed as a word, or the previous
  // character's audio bleeding in. None of it is failing to know the line.
  const beat = "Did you ever hear the like?";
  const score = scoreBeat(
    beat,
    "um did you, did you ever hear the like you know",
  );
  assertEquals(score.recall, 1);
  assertEquals(score.missed, false);
});

Deno.test("saying the right words in the wrong order is not the line", () => {
  // A set-based comparison would call this perfect. Order has to hold.
  const score = scoreBeat(
    "have melted him in his own grease",
    "grease own his in him melted have",
  );
  assertLess(score.recall, 0.5);
  assertEquals(score.missed, true);
});

Deno.test("half a beat delivered reads as a miss", () => {
  const beat =
    "What tempest, I trow, threw this whale, with so many tuns of oil in his belly, ashore at Windsor?";
  const score = scoreBeat(beat, "what tempest i trow threw this whale");
  assertLess(score.recall, 0.7);
  assertEquals(score.missed, true);
  assertEquals(score.blank, false);
});

Deno.test("repeating herself doesn't double-count", () => {
  // She restarts the line. Recall is capped by the expected words, so a second
  // attempt can't push it above 1, and the better attempt is what lands.
  const beat = "Did you ever hear the like?";
  const score = scoreBeat(beat, "did you ever, did you ever hear the like");
  assertEquals(score.recall, 1);
});

Deno.test("an empty beat is not scoreable and is not a miss", () => {
  // Guard, not a case, the importer doesn't produce one. What matters is that it
  // can't write NaN into confidence_score.
  const score = scoreBeat("", "anything at all");
  assertEquals(score.recall, 1);
  assertEquals(score.missed, false);
  assertEquals(Number.isFinite(score.recall), true);
});
