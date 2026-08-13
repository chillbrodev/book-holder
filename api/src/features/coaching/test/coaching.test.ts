import { assertEquals } from "@std/assert";
import { CoachingService } from "../service.ts";
import type { CoachBlockInput } from "../service.ts";

/**
 * The model is not called here. These cover the paths that have to hold when it
 * answers badly or not at all, which is the half of this feature that runs in
 * front of an actor on a bad day, and the half a live call can't demonstrate.
 * The rubric's own behaviour is verified against real Bedrock by
 * `scripts/testCoachBlock.ts`, because that is the only thing that can.
 */

const SHALLOW: CoachBlockInput = {
  blockId: "block-1",
  playTitle: "The Merry Wives of Windsor",
  characterName: "Shallow",
  beats: [
    {
      lineId: "line-1",
      beatNumber: 1,
      expected:
        "Sir Hugh, persuade me not; I will make a Star-chamber matter of it",
      heard: "sir hugh persuade me not i will make a star chamber matter of it",
    },
    {
      lineId: "line-2",
      beatNumber: 2,
      expected:
        "if he were twenty Sir John Falstaffs, he shall not abuse Robert Shallow, esquire",
      heard: "",
    },
  ],
};

Deno.test("the fallback answers every beat and says it is the fallback", () => {
  const result = CoachingService.fallbackCoaching(SHALLOW);

  assertEquals(result.source, "fallback");
  assertEquals(result.beats.length, 2);
  assertEquals(result.beats.map((beat) => beat.lineId), ["line-1", "line-2"]);
  // No invented note; that is the part that needed a model.
  assertEquals(result.note, "");
});

Deno.test("the fallback calls a clean delivery solid and a blank one dry", () => {
  const result = CoachingService.fallbackCoaching(SHALLOW);

  assertEquals(result.beats[0].band, "solid");
  assertEquals(result.beats[0].confidence, 1);

  assertEquals(result.beats[1].band, "dry");
  assertEquals(result.beats[1].confidence, 0);
});

Deno.test("a block with no beats is not a Bedrock call", async () => {
  // Guard rather than a case, the importer doesn't produce one. It matters
  // only because the alternative is paying for a call that can say nothing.
  const result = await CoachingService.coachBlock({
    blockId: "empty",
    playTitle: "The Merry Wives of Windsor",
    characterName: "Shallow",
    beats: [],
  });

  assertEquals(result.beats, []);
  assertEquals(result.note, "");
});

Deno.test("coachBlock never throws when the model call fails", async () => {
  // The whole contract of this module in one test: `BE_PLAN.md` §5 says a
  // rehearsal is never blocked on the model. A model id that cannot resolve
  // exercises the real failure path, a genuine Bedrock round trip that comes
  // back a validation error, rather than a mock of one. Nothing is billed for
  // a request that never reaches a model.
  const result = await CoachingService.coachBlock(SHALLOW, {
    modelId: "definitely-not-a-model",
  });

  assertEquals(result.source, "fallback");
  assertEquals(result.beats.length, 2);
  assertEquals(result.beats[0].band, "solid");
  assertEquals(result.beats[1].band, "dry");
});
