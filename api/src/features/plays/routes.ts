import { Hono } from "hono";
import { PlaysService } from "./service.ts";
import type { AppEnv } from "../../types.ts";

const plays = new Hono<AppEnv>();

// No auth gate, deliberately — rehearsing works fully as a guest (see
// AppLayout.tsx's "Save Progress" affordance: opt-in, never a gate in front
// of the app). Auth is only for persisting progress, which isn't built yet.

plays.get("/", async (c) => c.json(await PlaysService.listPlays()));

plays.get(
  "/:playId/characters",
  async (c) => c.json(await PlaysService.listCharacters(c.req.param("playId"))),
);

plays.get(
  "/:playId/scenes",
  async (c) => c.json(await PlaysService.listScenes(c.req.param("playId"))),
);

plays.get("/:playId/scenes/:act/:scene/dialogue", async (c) => {
  const dialogue = await PlaysService.getSceneDialogue(
    c.req.param("playId"),
    c.req.param("act"),
    c.req.param("scene"),
  );
  return c.json(dialogue);
});

plays.get(
  "/:playId/lines/:lineId",
  async (c) => c.json(await PlaysService.getLine(c.req.param("lineId"))),
);

export default plays;
