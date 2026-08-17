import { Hono } from "hono";
import { sessionMiddleware } from "./middleware.ts";
import type { AppEnv } from "../../types.ts";

const auth = new Hono<AppEnv>();

/**
 * One endpoint, where there used to be four.
 *
 * `/register`, `/login` and `/logout` are gone rather than proxied: the browser
 * talks to Supabase directly for all three, and standing a pass-through in
 * front of that would put this API back on the credential path it was moved off.
 *
 * `/me` survives because it answers a question the frontend genuinely cannot
 * answer for itself. The Supabase client knows whether it *holds* a session;
 * only this route knows whether that session is one **this API** accepts —
 * right project, right audience, not expired against our clock. When the two
 * disagree (a token from another project, a stale deploy pointed at a different
 * SUPABASE_URL) the app looks signed-in and every write 401s, and this is the
 * one call that names that directly.
 */
auth.get("/me", sessionMiddleware, (c) => c.json(c.get("user")));

export default auth;
