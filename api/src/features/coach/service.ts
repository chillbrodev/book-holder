/**
 * The coach agent: reads her memory, decides what she should run next, and says
 * so in one sentence.
 *
 * This is the piece that makes the app agentic rather than LLM-powered. Every
 * other Bedrock call here is a function, text in, judgement out, one shot. This
 * one is given tools and a goal and chooses for itself what to look at, in what
 * order, and how much is enough. On a rehearsal with nothing to say, the right
 * number of tool calls is zero and the right recommendation is none.
 *
 * ## What it may and may not do
 *
 * It reads. It cannot write, cannot see another user's history, and cannot put
 * its own text into a query, the tools take ids and return rows, and the SQL is
 * fixed in `tools.ts`. The only thing that leaves this module is a note and a
 * choice of what to run next, and the choice is validated against her actual
 * part before it is stored.
 *
 * ## Why the recommendation is stored
 *
 * So that next time it can ask what it said last time and whether she did it.
 * An agent that cannot tell what it told you to do has no memory of its own,
 * it can only produce a fresh opinion each time, which is a chatbot with extra
 * steps. `coach_recommendation` (migration 010) is what closes that loop, and
 * `get_last_recommendation` is the tool that reads it back.
 */

import {
  type AgentTurn,
  converseWithTools,
} from "../../clients/bedrock-client/bedrockClient.ts";
import { ConfigClient } from "../../clients/config-client/configClient.ts";
import { DbClient } from "../../clients/cockroach-db/dbClient.ts";
import { buildCoachTools } from "./tools.ts";
import { COACH_AGENT_BRIEF, RECOMMENDATION_SCHEMA } from "./brief.ts";
import type { CoachRecommendation } from "./types.ts";

/** Enough for a few tool calls and a sentence. The note is capped hard in the
 * brief; this only stops a runaway. */
const MAX_OUTPUT_TOKENS = 700;

/**
 * The whole agent, wall-clock.
 *
 * It runs at the wrap-up, after a scene she has just finished, so a few seconds
 * is affordable in a way it would not be mid-rehearsal. Past this it is a page
 * that will not load, and no recommendation is better than a stalled wrap-up.
 */
const AGENT_TIMEOUT_MS = 25_000;

export const CoachService = {
  /**
   * Decide what she should do next, and remember having said it.
   *
   * Never throws. A wrap-up that fails to load because the coach had an opinion
   * it could not express is a worse outcome than a wrap-up with no coach on it,
   * and every caller treats `null` as "nothing to say", which is also a real
   * answer on a clean run.
   */
  async recommend(input: {
    userId: string;
    playId: string;
    characterId: string;
    /** The run that prompted this, for the audit trail. */
    sessionId?: string;
  }): Promise<CoachRecommendation | null> {
    try {
      return await withTimeout(runAgent(input), AGENT_TIMEOUT_MS);
    } catch (err) {
      console.error("Coach agent failed:", err);
      return null;
    }
  },

  /**
   * Her most recent recommendation, if it still stands.
   *
   * Read separately from `recommend` so the wrap-up can be revisited without
   * running the agent again, the same reasoning `coaching-plan.md` §5 gives for
   * storing the scene summary rather than regenerating it. Regenerating would
   * bill a call per refresh and produce different words for the same rehearsal,
   * which makes advice feel arbitrary in exactly the way advice must not.
   */
  async latest(
    input: { userId: string; playId: string; sessionId?: string },
  ): Promise<CoachRecommendation | null> {
    const result = await DbClient.getPool().query(
      `SELECT id, note, action, act, scene, block_ids
         FROM coach_recommendation
        WHERE user_id = $1 AND play_id = $2
          AND ($3::uuid IS NULL OR session_id = $3::uuid)
        ORDER BY created_at DESC
        LIMIT 1`,
      [input.userId, input.playId, input.sessionId ?? null],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      note: row.note,
      action: row.action,
      act: row.act,
      scene: row.scene,
      blockIds: row.block_ids ?? [],
    };
  },
};

async function runAgent(input: {
  userId: string;
  playId: string;
  characterId: string;
  sessionId?: string;
}): Promise<CoachRecommendation | null> {
  const tools = buildCoachTools(input);

  const result = await converseWithTools({
    modelId: ConfigClient.Bedrock.agentModelId,
    system: COACH_AGENT_BRIEF,
    userMessage:
      "She has just finished a rehearsal. Look at how she is doing and decide " +
      "what she should run next. Answer with the JSON object described in your " +
      "instructions and nothing else.",
    tools,
    maxTokens: MAX_OUTPUT_TOKENS,
    // Warmer than the scorer. Scoring wants the same verdict twice running; a
    // note wants to sound like a person rather than a template, and the same
    // observation phrased identically every session reads as canned.
    temperature: 0.4,
  });

  console.info(
    `Coach agent: ${result.turns.length} tool call(s) [${
      result.turns.map((t) => t.tool).join(", ")
    }], ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`,
  );

  if (result.exhausted) {
    // It kept asking for tools and never answered. Treated as "no
    // recommendation" rather than as a failure to surface: she does not need to
    // know the coach got stuck.
    console.warn("Coach agent exhausted its turns without answering.");
    return null;
  }

  // The answer arrives as `submit_recommendation`'s arguments. The prose parse
  // below is only a fallback for a model that answered in text anyway; it is
  // how this worked at first, and it failed exactly as you would expect: Nova
  // Lite reasoned inside a `<thinking>` block and emitted no object at all.
  const parsed = result.final
    ? (result.final as RawRecommendation)
    : parseRecommendation(result.text);
  if (!parsed) {
    // Distinct from "nothing to say": the agent answered and the answer was not
    // usable. Logged with the text, because the alternative is a silent null
    // that looks identical to a clean run, which is exactly the confusion the
    // first version of this caused.
    console.warn(
      `Coach agent answer did not parse: ${
        JSON.stringify(result.text.slice(0, 300))
      }`,
    );
    return null;
  }
  if (parsed.action === "none") {
    console.info("Coach agent had nothing worth saying.");
    return null;
  }

  const validated = await validate(parsed, input);
  if (!validated) {
    // Usually a hallucinated line id or a scene she has no lines in. Caught
    // here rather than at the point she taps it.
    console.warn(
      `Coach agent recommendation failed validation: ${JSON.stringify(parsed)}`,
    );
    return null;
  }

  return await store(validated, input, result.turns);
}

interface RawRecommendation {
  note?: unknown;
  action?: unknown;
  act?: unknown;
  scene?: unknown;
  lineIds?: unknown;
}

/**
 * Pull the object out of the agent's final message.
 *
 * Nova is asked for JSON and mostly gives it, sometimes fenced, occasionally
 * with a sentence in front. The same scraping `bedrockClient.parseJsonFromText`
 * does for the single-tool path, and for the same reason, a malformed wrapper
 * around a good answer is not worth discarding the answer over.
 *
 * A forced tool call could have guaranteed the shape, as `converseJson` does.
 * It is deliberately not used here: forcing a tool on the final turn would mean
 * the model can never simply *stop*, and "nothing worth saying" has to remain
 * expressible.
 */
function parseRecommendation(text: string): RawRecommendation | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as RawRecommendation;
  } catch {
    return null;
  }
}

interface ValidRecommendation {
  note: string;
  action: "drill" | "scene";
  act: string;
  scene: string;
  blockIds: string[];
}

/**
 * Check the agent's choice against her actual part before storing it.
 *
 * The model returns `lineIds` it saw in tool output, and this resolves them to
 * blocks, because a drill runs whole speeches, and because resolving here means
 * a hallucinated id becomes an empty result rather than a session that cannot
 * start. `SessionLifecycle.start` would reject unknown blocks anyway; failing
 * at the point of *recommending* is better than recommending something that
 * fails when she taps it.
 */
async function validate(
  raw: RawRecommendation,
  scope: { userId: string; playId: string; characterId: string },
): Promise<ValidRecommendation | null> {
  const note = unwrap(typeof raw.note === "string" ? raw.note : "");
  if (note.length === 0) return null;

  const action = raw.action === "drill" || raw.action === "scene"
    ? raw.action
    : null;
  if (!action) return null;

  if (action === "scene") {
    const act = String(raw.act ?? "").trim();
    const scene = String(raw.scene ?? "").trim();
    if (!act || !scene) return null;
    const exists = await DbClient.getPool().query(
      `SELECT 1 FROM lines l
         JOIN line_speakers ls ON ls.line_id = l.id AND ls.character_id = $2
        WHERE l.play_id = $1 AND l.act = $3 AND l.scene = $4 LIMIT 1`,
      [scope.playId, scope.characterId, act, scene],
    );
    if (exists.rows.length === 0) return null;
    return { note, action, act, scene, blockIds: [] };
  }

  const lineIds = Array.isArray(raw.lineIds)
    ? raw.lineIds.filter((id): id is string => typeof id === "string")
    : [];
  if (lineIds.length === 0) return null;

  // Blocks, not beats, and all from one scene, because a session is scoped to
  // one (migration 008). If the agent picked lines across scenes, the first
  // scene wins rather than the recommendation being thrown away.
  const blocks = await DbClient.getPool().query(
    `SELECT DISTINCT l.block_id, l.act, l.scene, min(l.line_number) AS ord
       FROM lines l
       JOIN line_speakers ls ON ls.line_id = l.id AND ls.character_id = $2
      WHERE l.play_id = $1 AND l.id = ANY($3::uuid[])
      GROUP BY l.block_id, l.act, l.scene
      ORDER BY ord`,
    [scope.playId, scope.characterId, lineIds],
  );
  if (blocks.rows.length === 0) return null;

  const act = blocks.rows[0].act as string;
  const scene = blocks.rows[0].scene as string;
  const sameScene = blocks.rows.filter((r: { act: string; scene: string }) =>
    r.act === act && r.scene === scene
  );

  return {
    note,
    action,
    act,
    scene,
    blockIds: sameScene.map((r: { block_id: string }) => r.block_id),
  };
}

async function store(
  rec: ValidRecommendation,
  scope: { userId: string; playId: string; sessionId?: string },
  turns: AgentTurn[],
): Promise<CoachRecommendation> {
  const result = await DbClient.getPool().query(
    `INSERT INTO coach_recommendation
       (user_id, play_id, session_id, note, action, act, scene, block_ids, tool_calls)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9::jsonb)
     RETURNING id`,
    [
      scope.userId,
      scope.playId,
      scope.sessionId ?? null,
      rec.note,
      rec.action,
      rec.act,
      rec.scene,
      rec.blockIds,
      // Stored so "why did it say that" is answerable without re-running it.
      JSON.stringify(turns),
    ],
  );

  return {
    id: result.rows[0].id,
    note: rec.note,
    action: rec.action,
    act: rec.act,
    scene: rec.scene,
    blockIds: rec.blockIds,
  };
}

/**
 * Strip quotation marks that wrap the *whole* note, and only then.
 *
 * The model sometimes returns its sentence already inside quotes, which renders
 * as the app quoting itself. But a good note opens with a quoted line, the
 * brief demands one, so stripping a leading quote unconditionally orphans its
 * partner: `"Who's within there? ho!" has been missed twice` became
 * `Who's within there? ho!" has been missed twice`. The first version of this
 * did exactly that.
 *
 * So both ends must be quotes before either is removed.
 */
function unwrap(note: string): string {
  const trimmed = note.trim();
  const open = /^["'\u201c\u2018]/;
  const close = /["'\u201d\u2019]$/;
  if (open.test(trimmed) && close.test(trimmed)) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Coach agent timed out after ${ms}ms`)),
      ms,
    );
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export { RECOMMENDATION_SCHEMA };
