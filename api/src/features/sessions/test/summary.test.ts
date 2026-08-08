import { assertEquals, assertRejects } from "@std/assert";
import { SessionService } from "../service.ts";
import { SessionError } from "../errors.ts";

/**
 * Argument validation only — these run without a database, like the Polly
 * service tests.
 *
 * The parts that need real rows (that `beats_run` survives the round trip, that
 * flagged beats come back in spoken order, that another user holding the session
 * id is refused) were checked against the live database instead, because none of
 * them can fail in a way a type check or a stub would notice. See the hand-off.
 */

const USER_ID = "11111111-1111-1111-1111-111111111111";

Deno.test("getSessionSummary rejects a missing playId", async () => {
  const err = await assertRejects(
    () =>
      SessionService.getSessionSummary({
        userId: USER_ID,
        act: "II",
        scene: "I",
      }),
    SessionError,
  );
  assertEquals(err.name, "VALIDATION_ERROR");
});

Deno.test("getSessionSummary rejects a blank scene", async () => {
  const err = await assertRejects(
    () =>
      SessionService.getSessionSummary({
        userId: USER_ID,
        playId: USER_ID,
        act: "II",
        scene: "   ",
      }),
    SessionError,
  );
  assertEquals(err.name, "VALIDATION_ERROR");
});
