// PollyService's own validation logic — these throw before ever touching
// S3/Polly/the database, so they're safe to exercise without live AWS
// credentials or a live cluster. The cache-hit/cache-miss/synthesize/degrade
// branches are verified manually against real AWS, same as the DB-touching
// auth paths — see BE_PLAN.md.
import { assertEquals, assertRejects } from "@std/assert";
import { PollyService } from "../service.ts";
import { PollyError } from "../errors.ts";

Deno.test("getLineAudio rejects a missing lineId", async () => {
  const err = await assertRejects(
    () =>
      PollyService.getLineAudio({
        characterId: "22222222-2222-2222-2222-222222222222",
      }),
    PollyError,
  );
  assertEquals(err.name, "VALIDATION_ERROR");
  assertEquals(err.statusCode, 400);
});

Deno.test("getLineAudio rejects a missing characterId", async () => {
  const err = await assertRejects(
    () =>
      PollyService.getLineAudio({
        lineId: "11111111-1111-1111-1111-111111111111",
      }),
    PollyError,
  );
  assertEquals(err.name, "VALIDATION_ERROR");
});

Deno.test("getLineAudio rejects a blank characterId", async () => {
  const err = await assertRejects(
    () =>
      PollyService.getLineAudio({
        lineId: "11111111-1111-1111-1111-111111111111",
        characterId: "   ",
      }),
    PollyError,
  );
  assertEquals(err.name, "VALIDATION_ERROR");
});
