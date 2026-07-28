import { Hono } from "hono";
import { sessionMiddleware } from "../auth/middleware.ts";
import { PollyService } from "./service.ts";
import type { AppEnv } from "../../types.ts";

const polly = new Hono<AppEnv>();

// Every call here is a potential billed Polly/S3 round trip, so it's gated
// behind a session rather than left open (BE_PLAN.md §4 — guard against
// runaway calls).
polly.get("/lines/:lineId/audio", sessionMiddleware, async (c) => {
  const audio = await PollyService.getLineAudio({
    lineId: c.req.param("lineId"),
    characterId: c.req.query("characterId"),
  });
  return c.json(audio);
});

export default polly;
