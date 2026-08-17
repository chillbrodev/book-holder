// Route-level wiring via Hono's app.request(). AuthService is a plain exported
// object (like DbClient/ConfigClient), so tests fake it by swapping a method for
// the duration of the test and restoring it after — no network, no Supabase,
// no real tokens. What's verified here is the HTTP shape: that a token reaches
// the verifier at all, and that a thrown AuthError comes back as a 401 through
// app.ts's onError rather than a 500. Whether a given token is *valid* is
// supabaseJwt.test.ts's job.
import { assertEquals } from "@std/assert";
import { app } from "../../app/app.ts";
import { AuthService } from "../service.ts";
import { AuthError } from "../errors.ts";

function withFakeGetUser(
  fn: typeof AuthService.getUser,
  test: () => Promise<void>,
) {
  const original = AuthService.getUser;
  AuthService.getUser = fn;
  return test().finally(() => {
    AuthService.getUser = original;
  });
}

const fakeUser = {
  id: "6f1d2a54-0000-4000-8000-000000000001",
  email: "beatrice@example.com",
  name: "Beatrice",
};

Deno.test("GET /auth/me returns the actor the token verifies to", async () => {
  await withFakeGetUser(
    () => Promise.resolve(fakeUser),
    async () => {
      const res = await app.request("/auth/me", {
        headers: { authorization: "Bearer good.token.here" },
      });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), fakeUser);
    },
  );
});

Deno.test("GET /auth/me hands the bearer token to AuthService, not the whole header", async () => {
  // The scheme belongs to the transport; passing "Bearer x" through to the
  // verifier would fail every request, and only in a deployed environment.
  let seen: string | undefined = "unset";
  await withFakeGetUser(
    (token) => {
      seen = token;
      return Promise.resolve(fakeUser);
    },
    async () => {
      await app.request("/auth/me", {
        headers: { authorization: "Bearer good.token.here" },
      });
    },
  );
  assertEquals(seen, "good.token.here");
});

Deno.test("GET /auth/me is a 401 when nothing is signed in", async () => {
  const res = await app.request("/auth/me");
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error.name, "UNAUTHENTICATED");
});

Deno.test("GET /auth/me surfaces a rejected token as a 401, not a 500", async () => {
  await withFakeGetUser(
    () => {
      throw new AuthError("UNAUTHENTICATED", "That sign-in has expired.");
    },
    async () => {
      const res = await app.request("/auth/me", {
        headers: { authorization: "Bearer stale.token.here" },
      });
      assertEquals(res.status, 401);
      const body = await res.json();
      assertEquals(body.error.name, "UNAUTHENTICATED");
    },
  );
});
