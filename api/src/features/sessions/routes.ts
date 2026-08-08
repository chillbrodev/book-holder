import { Hono } from "hono";
import { SessionService } from "./service.ts";
import { SessionError } from "./errors.ts";
import { sessionMiddleware } from "../auth/middleware.ts";
import type { AppEnv } from "../../types.ts";

const sessions = new Hono<AppEnv>();

/**
 * Auth-gated, unlike /plays, /polly and /capture.
 *
 * Not a policy choice so much as a schema one: `session_history.user_id`,
 * `line_mastery.user_id` and `mistake_log.user_id` are all NOT NULL REFERENCES
 * users(id), so there is nowhere to put a guest's history. Rehearsing still works
 * fully as a guest — she can hear the other parts, be listened to, and call for
 * lines — she just isn't remembered, which is what the header's "Save Progress"
 * has always been offering.
 *
 * `sessionMiddleware` throws UNAUTHENTICATED without a valid cookie, so the guest
 * case surfaces as a clean 401 that the client can treat as "nothing to save"
 * rather than as a failure.
 */
sessions.use("*", sessionMiddleware);

/** What to lean on this run, read from her own history. The read half of the
 * read-decide-act-write loop. */
sessions.get("/plan", async (c) => {
  const user = c.get("user");
  const plan = await SessionService.getSessionPlan({
    userId: user.id,
    playId: c.req.query("playId"),
    act: c.req.query("act"),
    scene: c.req.query("scene"),
    characterId: c.req.query("characterId"),
  });
  return c.json(plan);
});

/** How the run she just finished actually went. The wrap-up's numbers come from
 * here — before this they were fixtures, which is why the screen could show a
 * duration for a rehearsal that was never saved. */
sessions.get("/summary", async (c) => {
  const user = c.get("user");
  const summary = await SessionService.getSessionSummary({
    userId: user.id,
    playId: c.req.query("playId"),
    act: c.req.query("act"),
    scene: c.req.query("scene"),
    sessionId: c.req.query("sessionId"),
  });
  return c.json(summary);
});

/** The whole rehearsal, written at the end in one transaction. */
sessions.post("/", async (c) => {
  const user = c.get("user");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new SessionError("VALIDATION_ERROR", "Expected a JSON body.");
  }

  const {
    playId,
    act,
    scene,
    durationSeconds,
    attempts,
  } = (body ?? {}) as Record<string, unknown>;

  const saved = await SessionService.saveSession({
    userId: user.id,
    playId: String(playId ?? ""),
    act: String(act ?? ""),
    scene: String(scene ?? ""),
    durationSeconds: Number(durationSeconds ?? 0),
    // Shape-checked here rather than trusted: the service reads the expected text
    // from the database by these ids, so a malformed entry would otherwise reach
    // a query as undefined.
    attempts: Array.isArray(attempts)
      ? attempts
        .filter((attempt): attempt is { lineId: string; heard?: unknown } =>
          typeof attempt === "object" && attempt !== null &&
          typeof (attempt as { lineId?: unknown }).lineId === "string"
        )
        .map((attempt) => ({
          lineId: attempt.lineId,
          heard: typeof attempt.heard === "string" ? attempt.heard : "",
        }))
      : [],
  });

  return c.json(saved, 201);
});

export default sessions;
