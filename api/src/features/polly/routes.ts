import { Hono } from "hono";
import { PollyService } from "./service.ts";
import type { AppEnv } from "../../types.ts";

const polly = new Hono<AppEnv>();

// No auth gate — rehearsing (including hearing other characters) works
// fully as a guest, matching /plays. Every miss is still a potential billed
// Polly/S3 call (BE_PLAN.md §4), but the whole play is pre-warmed/cached in
// S3, so in practice almost every real request is a cheap cache hit, not
// fresh synthesis. Revisit if a play is ever added without pre-warming it.
polly.get("/lines/:lineId/audio", async (c) => {
  const audio = await PollyService.getLineAudio({
    lineId: c.req.param("lineId"),
    characterId: c.req.query("characterId"),
  });
  return c.json(audio);
});

export default polly;
