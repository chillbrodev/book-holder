import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { ConfigClient } from "../../clients/config-client/configClient.ts";
import { AuthService } from "./service.ts";
import { sessionMiddleware } from "./middleware.ts";
import type { AppEnv } from "../../types.ts";

const auth = new Hono<AppEnv>();

function setSessionCookie(c: Context, token: string): void {
  setCookie(c, ConfigClient.Auth.sessionCookieName, token, {
    httpOnly: true,
    secure: ConfigClient.Server.isProduction,
    // Frontend (Amplify) and API (ECS) are different origins in production,
    // so cross-site cookies need SameSite=None — which browsers only honor
    // alongside Secure, hence tying this to isProduction rather than always
    // using "None". If FE/BE ever move under one parent domain, Lax +
    // Domain=.example.com would be the stricter, preferable choice.
    sameSite: ConfigClient.Server.isProduction ? "None" : "Lax",
    path: "/",
    maxAge: ConfigClient.Auth.sessionTtlDays * 24 * 60 * 60,
  });
}

// Routes assume success — all validation/credential/lockout logic lives in
// AuthService and throws AuthError, which app.ts's onError translates to a
// response. Nothing here branches on failure.

auth.post("/register", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { user, token } = await AuthService.register(body);
  setSessionCookie(c, token);
  return c.json(user, 201);
});

auth.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { user, token } = await AuthService.login(body);
  setSessionCookie(c, token);
  return c.json(user);
});

auth.post("/logout", async (c) => {
  await AuthService.logout(getCookie(c, ConfigClient.Auth.sessionCookieName));
  deleteCookie(c, ConfigClient.Auth.sessionCookieName, { path: "/" });
  return c.body(null, 204);
});

auth.get("/me", sessionMiddleware, (c) => {
  return c.json(c.get("user"));
});

export default auth;
