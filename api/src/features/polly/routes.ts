import { Hono } from "hono";
import { PollyService } from "./service.ts";
import type { AppEnv } from "../../types.ts";

const polly = new Hono<AppEnv>();

// No auth gate, rehearsing (including hearing other characters) works
// fully as a guest, matching /plays. Every miss is still a potential billed
// Polly/S3 call (BE_PLAN.md §4), but the whole play is pre-warmed/cached in
// S3, so in practice almost every real request is a cheap cache hit, not
// fresh synthesis. Revisit if a play is ever added without pre-warming it.
// Keyed on the block, not the beat; one speech is one render. The client
// sends only the block id; the server concatenates that block's beats in
// order, because the grouping lives in the database (assigned at import) and
// must not be re-derived from a client-supplied list.
polly.get("/blocks/:blockId/audio", async (c) => {
  const audio = await PollyService.getBlockAudio({
    blockId: c.req.param("blockId"),
    characterId: c.req.query("characterId"),
  });
  return c.json(audio);
});

export default polly;
