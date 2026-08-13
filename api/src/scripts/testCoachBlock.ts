// One real Bedrock call against the coaching rubric, printed for reading.
//
// This exists because the thing most likely to be wrong about this feature
// cannot be unit tested. `docs/coaching-plan.md` §8 records the first real Nova
// call returning the note *"the capitalization of 'Songs' and 'Sonnets' was
// missed"*, about a speech the actor said out loud. Nothing about that is
// visible in a type, a mock, or a schema; it only shows up when a real model
// reads the real rubric. So the rubric's actual job, knowing it is reading a
// speech-to-text transcript, is verified here or nowhere.
//
// No database. The block below is synthetic and chosen to put one of each case
// in front of the model at once, including the two that were observed going
// wrong on real runs.
//
// Usage:
//   deno task test-coach-block

import { CoachingService } from "../features/coaching/service.ts";
import type { CoachBlockInput } from "../features/coaching/service.ts";

/**
 * Four beats, each testing something different:
 *
 * 1. Clean delivery, only transcriber artifacts: no capitals, no punctuation,
 *    "star chamber" split. Must be solid, and must draw no note about
 *    spelling or punctuation. This is the §8 regression.
 * 2. Real transcriber damage on a proper noun, taken from an actual run
 *    (`sessions/test/score.test.ts`): "'Custalourum" came back "Castellorum",
 *    and "Ay" came back "I". She said it. Must be solid.
 * 3. A genuine paraphrase; the meaning is there, the words are not. This is
 *    the case word overlap cannot see and the whole reason for using a model.
 *    Must be close.
 * 4. Nothing heard. Must be dry at confidence 0, with no benefit of the
 *    doubt.
 */
const BLOCK: CoachBlockInput = {
  blockId: "scratch-block",
  playTitle: "The Merry Wives of Windsor",
  characterName: "Shallow",
  beats: [
    {
      lineId: "beat-1-clean-but-untidy-transcript",
      beatNumber: 1,
      expected:
        "Sir Hugh, persuade me not; I will make a Star-chamber matter of it:",
      heard: "sir hugh persuade me not i will make a star chamber matter of it",
    },
    {
      lineId: "beat-2-transcriber-mangled-proper-noun",
      beatNumber: 2,
      expected: "Ay, cousin Slender, and 'Custalourum.",
      heard: "I Cousin Slender and Castellorum",
    },
    {
      lineId: "beat-3-real-paraphrase",
      beatNumber: 3,
      expected:
        "if he were twenty Sir John Falstaffs, he shall not abuse Robert Shallow, esquire.",
      heard:
        "even if there were twenty of him he's not going to treat me like that i'm a gentleman",
    },
    {
      lineId: "beat-4-said-nothing",
      beatNumber: 4,
      expected: "The Council shall hear it; it is a riot.",
      heard: "",
    },
  ],
};

const EXPECTED_BANDS = ["solid", "solid", "close", "dry"] as const;

/** Words that in a note mean the rubric's central instruction did not land. */
const FORBIDDEN_IN_NOTE = [
  "capital",
  "capitalis",
  "capitaliz",
  "punctuat",
  "spell",
  "comma",
  "apostrophe",
  "transcri",
  // Added after a real run produced "the name 'Custalourum' was misheard",
  // technically true, about the transcriber, and useless to an actor who said
  // the word correctly. The rubric bans mentioning the transcriber; this is
  // that same instruction being evaded by not using the word.
  "mishear",
  "misheard",
  "pronounc",
];

if (import.meta.main) {
  const startedAt = Date.now();
  const result = await CoachingService.coachBlock(BLOCK);
  const elapsedMs = Date.now() - startedAt;

  console.log(`\nsource: ${result.source}   (${elapsedMs} ms)`);
  if (result.source === "fallback") {
    console.log(
      "\n!! Bedrock did not answer — this run proves nothing about the rubric.\n" +
        "   Check credentials and the model id, then run it again.",
    );
    Deno.exit(1);
  }

  console.log("\nbeats:");
  let bandsCorrect = 0;
  result.beats.forEach((beat, index) => {
    const want = EXPECTED_BANDS[index];
    const ok = beat.band === want;
    if (ok) bandsCorrect++;
    console.log(
      `  ${index + 1}. ${ok ? "OK  " : "MISS"} got ${beat.band.padEnd(5)} ` +
        `want ${want.padEnd(5)} conf ${beat.confidence.toFixed(2)}  ` +
        `${BLOCK.beats[index].lineId}`,
    );
  });

  console.log(`\nnote: ${result.note === "" ? "(none)" : result.note}`);

  const lowerNote = result.note.toLowerCase();
  const offending = FORBIDDEN_IN_NOTE.filter((word) =>
    lowerNote.includes(word)
  );

  // The quote test, checked rather than trusted. A note either carries words
  // lifted from the written speech or it is filler that restates the marks,
  // and filler is no longer harmless, because the rehearsal now *pauses* on a
  // note (`coaching-plan.md` §4). A note that says nothing costs her six
  // seconds of a scene.
  const written = BLOCK.beats.map((beat) => beat.expected.toLowerCase()).join(
    " ",
  );
  const quoted = [...result.note.matchAll(/"([^"]{2,})"|'([^']{4,})'/g)]
    .map((match) => (match[1] ?? match[2]).toLowerCase().trim())
    .filter((phrase) => phrase.split(/\s+/).length >= 2);
  const quotesFromSpeech = quoted.filter((phrase) => written.includes(phrase));
  const notePasses = result.note.length === 0 || quotesFromSpeech.length > 0;

  console.log("\n--- verdict ---");
  console.log(`bands correct:      ${bandsCorrect}/${EXPECTED_BANDS.length}`);
  console.log(
    `note quotes the speech (or is empty): ${
      notePasses
        ? result.note.length === 0
          ? "yes — empty"
          : `yes — ${JSON.stringify(quotesFromSpeech[0])}`
        : "NO — filler, would pause the scene for nothing"
    }`,
  );
  console.log(
    `note stays off the transcript: ${
      offending.length === 0 ? "yes" : `NO — mentions ${offending.join(", ")}`
    }`,
  );

  // Both are hard failures now. The §8 regression is a note telling an actor to
  // fix punctuation she never typed; the quote test failing is a note that
  // restates the marks, which since §4's pause reversal costs her six seconds of
  // the scene rather than merely being useless. A band being off stays a tuning
  // question, worth seeing rather than exiting over.
  if (offending.length > 0 || !notePasses) Deno.exit(1);
}
