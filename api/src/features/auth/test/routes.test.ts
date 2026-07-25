// Route-level tests via Hono's app.request(). AuthService is a plain
// exported object (like DbClient/ConfigClient), so tests fake it by
// swapping a method for the duration of the test and restoring it after —
// no DB, no real business logic, just verifying the HTTP wiring: status
// codes, cookie-setting, response shape, and that thrown AuthErrors reach
// the client via app.ts's onError. Business-logic behavior (validation
// rules, lockout counting, etc.) is AuthService's own concern — see
// service.test.ts.
import { assertEquals, assertMatch } from "@std/assert";
import { app } from "../../app/app.ts";
import { AuthService } from "../service.ts";
import { AuthError } from "../errors.ts";

function withFakeRegister(
  fn: typeof AuthService.register,
  test: () => Promise<void>,
) {
  const original = AuthService.register;
  AuthService.register = fn;
  return test().finally(() => {
    AuthService.register = original;
  });
}

function withFakeLogin(
  fn: typeof AuthService.login,
  test: () => Promise<void>,
) {
  const original = AuthService.login;
  AuthService.login = fn;
  return test().finally(() => {
    AuthService.login = original;
  });
}

function withFakeGetSessionUser(
  fn: typeof AuthService.getSessionUser,
  test: () => Promise<void>,
) {
  const original = AuthService.getSessionUser;
  AuthService.getSessionUser = fn;
  return test().finally(() => {
    AuthService.getSessionUser = original;
  });
}

const fakeUser = { id: "fake-id", username: "mom", name: "Mom" };

Deno.test("POST /auth/register returns the created user and sets a session cookie", async () => {
  await withFakeRegister(
    () =>
      Promise.resolve({
        user: fakeUser,
        token: "fake-token",
        expiresAt: new Date(),
      }),
    async () => {
      const res = await app.request("/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "mom", name: "Mom", pin: "4242" }),
      });
      assertEquals(res.status, 201);
      const body = await res.json();
      assertEquals(body, fakeUser);
      assertMatch(
        res.headers.get("set-cookie") ?? "",
        /book_holder_session=fake-token/,
      );
    },
  );
});

Deno.test("POST /auth/register surfaces AuthService's validation error as a 400", async () => {
  await withFakeRegister(
    () => {
      throw new AuthError(
        "VALIDATION_ERROR",
        "username, name, and pin are all required.",
      );
    },
    async () => {
      const res = await app.request("/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assertEquals(res.status, 400);
      const body = await res.json();
      assertEquals(body.error.name, "VALIDATION_ERROR");
    },
  );
});

Deno.test("POST /auth/register surfaces AuthService's username-taken error as a 409", async () => {
  await withFakeRegister(
    () => {
      throw new AuthError("USERNAME_TAKEN", "That username is already in use.");
    },
    async () => {
      const res = await app.request("/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "mom", name: "Mom", pin: "4242" }),
      });
      assertEquals(res.status, 409);
    },
  );
});

Deno.test("POST /auth/login returns the user and sets a session cookie on success", async () => {
  await withFakeLogin(
    () =>
      Promise.resolve({
        user: fakeUser,
        token: "fake-token",
        expiresAt: new Date(),
      }),
    async () => {
      const res = await app.request("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "mom", pin: "4242" }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body, fakeUser);
      assertMatch(
        res.headers.get("set-cookie") ?? "",
        /book_holder_session=fake-token/,
      );
    },
  );
});

Deno.test("POST /auth/login surfaces AuthService's lockout error as a 423", async () => {
  await withFakeLogin(
    () => {
      throw new AuthError(
        "ACCOUNT_LOCKED",
        "Too many failed attempts. Try again in 900 seconds.",
      );
    },
    async () => {
      const res = await app.request("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "mom", pin: "0000" }),
      });
      assertEquals(res.status, 423);
    },
  );
});

Deno.test("GET /auth/me returns the session user on success", async () => {
  await withFakeGetSessionUser(
    () => Promise.resolve(fakeUser),
    async () => {
      const res = await app.request("/auth/me");
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body, fakeUser);
    },
  );
});

Deno.test("GET /auth/me surfaces AuthService's unauthenticated error as a 401", async () => {
  await withFakeGetSessionUser(
    () => {
      throw new AuthError("UNAUTHENTICATED", "Not logged in.");
    },
    async () => {
      const res = await app.request("/auth/me");
      assertEquals(res.status, 401);
      const body = await res.json();
      assertEquals(body.error.name, "UNAUTHENTICATED");
    },
  );
});
