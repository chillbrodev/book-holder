import { assertEquals } from "@std/assert";
import { interleaveSceneStream } from "../service.ts";
import type { DialogueEntryRow } from "../service.ts";

/**
 * The scene stream's ordering, which was wrong in production for as long as
 * stage directions have existed and which nothing failed on.
 *
 * It was found from a screenshot: a speech appeared twice with a direction
 * between the halves, both halves carrying the same `BLOCK` id. The audible
 * version was worse, `getBlockAudio` keys on the block, so both halves asked
 * for the same recording and the scene read the whole speech, then read it
 * again.
 */

function beat(lineNumber: number, text: string, blockId = "b"): {
  lineNumber: number;
  entry: DialogueEntryRow;
} {
  return {
    lineNumber,
    entry: {
      type: "speech",
      lineId: `line-${lineNumber}`,
      lineNumber,
      blockId,
      beatNumber: 1,
      text,
      sourceLines: [text],
      sharesFirstSourceLine: false,
      isVerse: false,
      speakerIds: ["c"],
      speakerNames: ["QUICKLY"],
    },
  };
}

function direction(afterLineNumber: number, text: string, sequence = 0) {
  return {
    afterLineNumber,
    sequence,
    entry: { type: "stage" as const, text },
  };
}

const said = (entries: DialogueEntryRow[]) =>
  entries.map((e) => (e.type === "stage" ? `-- ${e.text}` : e.text));

Deno.test("a direction anchored to a beat comes after that beat", () => {
  // The exact shape that broke: both beats belong to one block, and
  // "Re-enter RUGBY" is anchored to the second, so it follows the whole
  // speech rather than splitting it.
  const stream = interleaveSceneStream(
    [
      beat(18, "Well, heaven send Anne Page no worse fortune!"),
      beat(19, "Tell Master Parson Evans I will do what I can"),
    ],
    [direction(19, "Re-enter RUGBY")],
  );

  assertEquals(said(stream), [
    "Well, heaven send Anne Page no worse fortune!",
    "Tell Master Parson Evans I will do what I can",
    "-- Re-enter RUGBY",
  ]);
});

Deno.test("a block is never split by the direction that follows it", () => {
  const stream = interleaveSceneStream(
    [beat(18, "first", "block-1"), beat(19, "second", "block-1")],
    [direction(19, "Re-enter RUGBY")],
  );

  // Every beat of a block must be contiguous. Two runs of the same blockId is
  // precisely the bug: the display renders each run separately and both ask the
  // audio endpoint for the same whole-block recording.
  const blockIds = stream.filter((e) => e.type === "speech").map((e) =>
    e.type === "speech" ? e.blockId : ""
  );
  assertEquals(blockIds, ["block-1", "block-1"]);
});

Deno.test("an opening direction still comes before the first beat", () => {
  // after_line_number = 0 and beats numbered from 1, so there is nothing to
  // tie with; the tiebreak change must not disturb this.
  const stream = interleaveSceneStream(
    [beat(1, "What, John Rugby!")],
    [direction(0, "Enter MISTRESS QUICKLY, SIMPLE, and RUGBY")],
  );

  assertEquals(said(stream), [
    "-- Enter MISTRESS QUICKLY, SIMPLE, and RUGBY",
    "What, John Rugby!",
  ]);
});

Deno.test("a closing direction comes after the scene's last beat", () => {
  // "Exeunt" used to render before the final line of the scene.
  const stream = interleaveSceneStream(
    [beat(109, "Truly, an honest gentleman"), beat(110, "Out upon't!")],
    [direction(110, "Exit")],
  );

  assertEquals(said(stream), [
    "Truly, an honest gentleman",
    "Out upon't!",
    "-- Exit",
  ]);
});

Deno.test("directions sharing an anchor keep their import order", () => {
  // Real pair from I.iv, both anchored to beat 59. `sequence` was selected from
  // the database and then never used, so their order was whatever the rows
  // happened to arrive in.
  const stream = interleaveSceneStream(
    [beat(59, "a beat")],
    [
      direction(59, "Enter FORD with PISTOL, and PAGE", 1),
      direction(59, "They retire", 0),
    ],
  );

  assertEquals(said(stream), [
    "a beat",
    "-- They retire",
    "-- Enter FORD with PISTOL, and PAGE",
  ]);
});
