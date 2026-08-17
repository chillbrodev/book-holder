import { Hono } from "hono";
import { SessionService } from "./service.ts";
import { SessionLifecycle } from "./lifecycle.ts";
import { CoachService } from "../coach/service.ts";
import { SessionError } from "./errors.ts";
import { sessionMiddleware } from "../auth/middleware.ts";
import type { AppEnv } from "../../types.ts";

const sessions = new Hono<AppEnv>();

/**
 * Auth-gated, unlike /plays, /polly and /capture.
 *
 * Not a policy choice so much as a schema one: `session_history.user_id`,
 * `line_mastery.user_id` and `mistake_log.user_id` are all NOT NULL, so there is
 * nowhere to put a guest's history. (They no longer reference a local `users`
 * table — since migration 011 they hold the Supabase user's id — but NOT NULL is
 * what matters here, and that is unchanged.) Rehearsing still works fully as a
 * guest; she can hear the other parts, be listened to, and call for lines; she
 * just isn't remembered, which is what the header's "Save Progress" has always
 * been offering.
 *
 * `sessionMiddleware` throws UNAUTHENTICATED without a valid access token, so the
 * guest case surfaces as a clean 401 that the client can treat as "nothing to
 * save" rather than as a failure.
 */
sessions.use("*", sessionMiddleware);

/**
 * Open a session before she says anything.
 *
 * `coaching-plan.md` §6: the row is created at rehearsal start, not at save,
 * because per-block coaching needs somewhere to write while the scene is still
 * running. Returns the id the capture socket then carries.
 *
 * Body: { playId, act, scene, characterId, scope?, blockIds?, source? }
 */
sessions.post("/start", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const started = await SessionLifecycle.start({
    userId: user.id,
    playId: body.playId,
    act: body.act,
    scene: body.scene,
    characterId: body.characterId,
    scope: body.scope,
    blockIds: body.blockIds,
    source: body.source,
  });
  return c.json(started, 201);
});

/**
 * Mark a run finished, or leave it abandoned, which is also a real outcome.
 *
 * `completed_at` is set only when every block in `session_block` has all of its
 * beats scored, which is one question for a scene run and a drill set alike.
 */
sessions.post("/:sessionId/complete", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const result = await SessionLifecycle.complete({
    sessionId: c.req.param("sessionId"),
    userId: user.id,
    durationSeconds: Number(body.durationSeconds ?? 0),
  });
  return c.json(result);
});

/**
 * Her whole part: how much of it she has, and what she still hasn't.
 *
 * Deliberately not scene-scoped. The wrap-up answers "how did that run go";
 * this answers "where am I with this part", which no single session can.
 */
sessions.get("/prompt-book", async (c) => {
  const user = c.get("user");
  const book = await SessionService.getPromptBook({
    userId: user.id,
    playId: c.req.query("playId"),
    characterId: c.req.query("characterId"),
  });
  return c.json(book);
});

/**
 * What the coach thinks she should do next.
 *
 * `POST` rather than `GET` because it is not a read: the agent runs, spends
 * tokens, and writes a `coach_recommendation` row it will read back next time.
 * Idempotent it is not, and a client that retries should know that.
 *
 * Returns `{ recommendation: null }` when there is nothing worth saying, a
 * clean run deserves silence rather than manufactured praise, and also when
 * the agent failed, which the wrap-up treats identically. Never 500s: a wrap-up
 * that will not load because the coach had an opinion it could not express is
 * worse than a wrap-up with no coach on it.
 */
sessions.post("/:sessionId/coach", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const recommendation = await CoachService.recommend({
    userId: user.id,
    playId: body.playId,
    characterId: body.characterId,
    sessionId: c.req.param("sessionId"),
  });
  return c.json({ recommendation });
});

/**
 * The standing recommendation for this play, whichever session produced it.
 *
 * For the play page, so the coach is visible on the way *in* to a rehearsal
 * rather than only on the way out of one. Waiting until the end of a scene is a
 * long time to wait to see the thing decide something.
 *
 * A read, never a run — deliberately, and it is the difference between this and
 * the POST below. The play page is the first screen of a rehearsal and is
 * visited often; running the agent here would bill a loop on every visit and
 * reword yesterday's advice each time, which is what `coaching-plan.md` §5 says
 * makes advice read as arbitrary. Nothing new is said until she finishes a run.
 *
 * `{ recommendation: null }` when the agent has never spoken about this play, or
 * when what it last said has since been rejected as unusable. Silence is a real
 * answer, and the play page renders nothing at all for it.
 */
sessions.get("/coach", async (c) => {
  const user = c.get("user");
  const recommendation = await CoachService.latest({
    userId: user.id,
    playId: c.req.query("playId") ?? "",
  });
  return c.json({ recommendation });
});

/** The recommendation already made for a session, without running the agent
 * again, so revisiting a wrap-up costs nothing and says the same thing. */
sessions.get("/:sessionId/coach", async (c) => {
  const user = c.get("user");
  const recommendation = await CoachService.latest({
    userId: user.id,
    playId: c.req.query("playId") ?? "",
    sessionId: c.req.param("sessionId"),
  });
  return c.json({ recommendation });
});

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
 * here, before this they were fixtures, which is why the screen could show a
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
