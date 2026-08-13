// AuthService's own validation logic, these throw before ever calling
// DbClient.getPool(), so they're safe to exercise without a live database.
// The DB-touching branches (successful register/login, lockout counting,
// unique-violation handling) are verified manually against a real cluster
// rather than automated here. See BE_PLAN.md.
import { assertEquals, assertRejects } from "@std/assert";
import { AuthService } from "../service.ts";
import { AuthError } from "../errors.ts";

Deno.test("register rejects a missing pin", async () => {
  const err = await assertRejects(
    () => AuthService.register({ username: "mom", name: "Mom" }),
    AuthError,
  );
  assertEquals(err.name, "VALIDATION_ERROR");
  assertEquals(err.statusCode, 400);
});

Deno.test("register rejects a non-numeric pin", async () => {
  const err = await assertRejects(
    () => AuthService.register({ username: "mom", name: "Mom", pin: "abcd" }),
    AuthError,
  );
  assertEquals(err.name, "VALIDATION_ERROR");
});

Deno.test("register rejects a blank username", async () => {
  const err = await assertRejects(
    () => AuthService.register({ username: "   ", name: "Mom", pin: "4242" }),
    AuthError,
  );
  assertEquals(err.name, "VALIDATION_ERROR");
});

Deno.test("login rejects a missing username", async () => {
  const err = await assertRejects(
    () => AuthService.login({ pin: "4242" }),
    AuthError,
  );
  assertEquals(err.name, "VALIDATION_ERROR");
  assertEquals(err.statusCode, 400);
});

Deno.test("login rejects a missing pin", async () => {
  const err = await assertRejects(
    () => AuthService.login({ username: "mom" }),
    AuthError,
  );
  assertEquals(err.name, "VALIDATION_ERROR");
});

Deno.test("getSessionUser rejects a missing token", async () => {
  const err = await assertRejects(
    () => AuthService.getSessionUser(undefined),
    AuthError,
  );
  assertEquals(err.name, "UNAUTHENTICATED");
  assertEquals(err.statusCode, 401);
});
