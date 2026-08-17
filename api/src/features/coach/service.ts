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
      `SELECT id, note, rationale, action, act, scene, block_ids
         FROM coach_recommendation
        WHERE user_id = $1 AND play_id = $2
          AND ($3::uuid IS NULL OR session_id = $3::uuid)
        ORDER BY created_at DESC
        LIMIT 1`,
      [input.userId, input.playId, input.sessionId ?? null],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];

    // Filtered on the way out as well as on the way in. `validate` now rejects a
    // note that is nothing but a quoted line, but rows written before that check
    // existed are still in the table — and one of them is on the most recent
    // session, so the wrap-up would go on showing the actor her own script under
    // "From the Book Holder" until she happened to run the agent again. Silence
    // is a real answer here (`coaching-plan.md` §4); a bad note is not.
    if (isBareQuotation(row.note, await quotableLines(input.playId))) {
      return null;
    }

    return {
      id: row.id,
      note: row.note,
      // Rows written before migration 012 have none, and neither does a run
      // where the model skipped the field.
      rationale: row.rationale ?? "",
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
  observation?: unknown;
  advice?: unknown;
  rationale?: unknown;
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
  /** Why this speech, in her marks. Empty when the model didn't give one —
   * which never costs the recommendation; the note is the part that must be
   * there, and the screen simply omits the evidence line. */
  rationale: string;
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
/**
 * Rejects a "note" that is nothing but the line, copied out.
 *
 * The brief asks for a note in three steps: quote the line, say what keeps
 * happening to it, say what to do. Nova Lite reliably performs step 1 and stops.
 * Observed in production — a stored recommendation whose entire text was
 * *"From time to time I have acquainted you With the dear love I bear to fair
 * Anne Page; ..."*, with no sentence of coaching anywhere in it. `unwrap` then
 * strips the surrounding quotation marks, so the wrap-up rendered a copy of her
 * own script under the heading "From the Book Holder".
 *
 * Checked in code rather than argued in the prompt, for the reason
 * `features/coaching`'s `groundedNote` already established: three rubric
 * revisions failed to stop Nova emitting "All beats are dry", and the fix that
 * worked was a mechanical check, because the rule is mechanically checkable.
 * This one is too — does the note consist of a line of the play and nothing
 * else? — so it is checked.
 *
 * Deliberately narrow. It does not require a minimum length, count sentences, or
 * look for coaching vocabulary; any of those would reject a good short note. It
 * asks one question: with the quoted play text removed, is there anything left?
 */
/**
 * Builds a note out of the quoted line plus the model's own two sentences.
 *
 * Used only when `note` came back as the line and nothing else. The quotation is
 * kept — it is what makes a note about a *line* rather than about a run — and
 * the observation and advice are what turn it into something she can act on.
 *
 * Returns null when there is nothing to add, because a quoted line with an empty
 * sentence after it is the same failure with punctuation.
 */
function composeNote(quoted: string, raw: RawRecommendation): string | null {
  const sentence = (value: unknown) =>
    typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

  const observation = sentence(raw.observation);
  const advice = sentence(raw.advice);
  if (!observation && !advice) return null;

  const end = (text: string) => /[.!?]$/.test(text) ? text : `${text}.`;
  const body = [observation, advice].filter(Boolean).map(end).join(" ");

  // The line goes back inside quotation marks: `unwrap` stripped them on the way
  // in, and without them the speech and the note about it run together into one
  // sentence that reads as neither.
  return `\u201C${quoted.trim()}\u201D ${body}`;
}

/** The true shape of the recommended speeches, straight from her marks. */
export interface SpeechTally {
  beats: number;
  solid: number;
  close: number;
  dry: number;
}

/**
 * Does every number the agent used actually appear in her marks?
 *
 * The rationale is shown to her as evidence — "two of its nine beats are dry" —
 * and evidence that is wrong is worse than no evidence, because it is a
 * confident false claim about her own rehearsal. Nova Lite got this wrong on the
 * very first run: the tool description carried an example sentence and the model
 * shipped its numbers verbatim, reporting two of nine dry where the truth was
 * one of eleven.
 *
 * So it is checked, for the third time in this codebase and for the same reason
 * as `groundedNote` and `isBareQuotation`: the rule is mechanically checkable.
 * Every integer in the sentence must be one of the four real figures. That is
 * deliberately loose — it does not care which number is which, only that no
 * invented quantity appears — because tying each figure to its noun would need
 * to parse English, and the failure being guarded against is wholesale
 * fabrication, not a misattributed adjective.
 *
 * Numbers written as words are read too: the model writes "nine", not "9".
 */
export function rationaleMatchesMarks(
  rationale: string,
  tally: SpeechTally,
): boolean {
  const WORDS: Record<string, number> = {
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
  };
  const truth = new Set([tally.beats, tally.solid, tally.close, tally.dry]);

  const cited: number[] = [];
  for (const digits of rationale.match(/\d+/g) ?? []) {
    cited.push(Number(digits));
  }
  for (const [word, value] of Object.entries(WORDS)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(rationale)) cited.push(value);
  }

  // No numbers at all is not a lie, but it is not evidence either — the field
  // exists to carry counts, and a rationale without one is just more advice.
  if (cited.length === 0) return false;
  return cited.every((n) => truth.has(n));
}

/** The sentence the app writes when the agent's own is not usable. Plain on
 * purpose: it is a fallback, and its whole value is being true. */
export function composeRationale(tally: SpeechTally): string {
  const parts = [
    tally.dry > 0 ? `${tally.dry} dry` : "",
    tally.close > 0 ? `${tally.close} close` : "",
    tally.solid > 0 ? `${tally.solid} solid` : "",
  ].filter(Boolean);
  if (parts.length === 0) return "";
  const beats = `${tally.beats} ${tally.beats === 1 ? "beat" : "beats"}`;
  return `Of its ${beats}: ${parts.join(", ")}.`;
}

export function isBareQuotation(note: string, playLines: string[]): boolean {
  // Apostrophes are *removed* rather than turned into spaces, unlike every
  // other mark. Shakespeare is full of elisions — "answer'd", "'twixt",
  // "you'll" — and a model requoting a line frequently drops the apostrophe.
  // Mapping it to a space makes "answer'd" into two tokens and "answerd" into
  // one, so the echo no longer matches its own source line and walks straight
  // through the filter. Caught by a test, not in review.
  const normalise = (text: string) =>
    text
      .toLowerCase()
      .replace(/['\u2019]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  const normalisedNote = normalise(note);
  if (!normalisedNote) return true;

  for (const candidate of playLines) {
    const line = normalise(candidate);
    if (!line || !normalisedNote.includes(line)) continue;
    // The quoted span is genuinely in there. What remains is what she would
    // actually be told; under four words it is a label, not a note.
    const remainder = normalisedNote.replace(line, " ").trim();
    if (remainder.split(" ").filter(Boolean).length < 4) return true;
  }

  return false;
}

/** The play's quotable lines. Only ones long enough to be worth quoting: a
 * three-word beat ("Hark, good mine host.") legitimately appears inside a real
 * note with a sentence around it, and matching on it would reject that note. */
async function quotableLines(playId: string): Promise<string[]> {
  const rows = await DbClient.getPool().query(
    `SELECT text FROM lines WHERE play_id = $1 AND length(text) >= 40`,
    [playId],
  );
  return (rows.rows as { text: string }[]).map((row) => row.text);
}

async function validate(
  raw: RawRecommendation,
  scope: { userId: string; playId: string; characterId: string },
): Promise<ValidRecommendation | null> {
  const modelNote = unwrap(typeof raw.note === "string" ? raw.note : "");
  if (modelNote.length === 0) return null;
  let finalNote = modelNote;
  if (isBareQuotation(modelNote, await quotableLines(scope.playId))) {
    // Rebuilt from the structured fields rather than thrown away.
    //
    // Nova Lite writes the quoted line into `note` and stops — reliably, and
    // through a rubric revision written specifically to stop it, which is the
    // second time this codebase has learned that a prompt cannot enforce a rule
    // a machine can check (see `groundedNote` in features/coaching). So the
    // model is no longer trusted to compose the sentence: it is asked
    // separately what happened and what to do, which it answers well, and the
    // sentence is assembled here.
    //
    // The composed form is deliberately plain. It is a floor, not the intended
    // voice — when the model does write a real note, that note is used
    // untouched, because a person's phrasing beats a template every time.
    const composed = composeNote(modelNote, raw);
    if (!composed) {
      console.warn(
        `Coach note unusable — bare quotation and no observation/advice: ${
          JSON.stringify(modelNote.slice(0, 80))
        }`,
      );
      return null;
    }
    console.warn(
      "Coach note was a bare quotation; composed one from observation/advice.",
    );
    finalNote = composed;
  }

  const note = finalNote;

  // Trimmed and collapsed, not validated further. The numbers in it are the
  // model's claim about its own tool output; they are not re-derived here,
  // because a rationale that disagreed with the counts would be a reason to fix
  // the tool description rather than to silently rewrite what it said. It is
  // shown as the coach's reasoning, and reasoning is allowed to be wrong out
  // loud in a way a score never is.
  const rationale = typeof raw.rationale === "string"
    ? raw.rationale.trim().replace(/\s+/g, " ")
    : "";

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
    // A whole-scene recommendation has no block tally to check against, so a
    // counted claim cannot be verified here and is dropped rather than trusted.
    // The uncounted case — "you have never run this scene to the end" — is the
    // one that belongs on a scene action anyway.
    return {
      note,
      rationale:
        /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i
            .test(rationale)
          ? ""
          : rationale,
      action,
      act,
      scene,
      blockIds: [],
    };
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

  const blockIds = sameScene.map((r: { block_id: string }) => r.block_id);

  // Checked against her actual marks before it is shown as evidence. See
  // `rationaleMatchesMarks` for why this is a code check and not a stronger
  // instruction — it is the third time round on the same lesson.
  const tally = await speechTally(blockIds, scope.userId);
  const grounded = rationaleMatchesMarks(rationale, tally);
  if (rationale && !grounded) {
    console.warn(
      `Coach rationale cited counts that are not hers (truth: ${
        JSON.stringify(tally)
      }): ${JSON.stringify(rationale)}`,
    );
  }

  return {
    note,
    // Its own words when the numbers check out, the app's when they do not, and
    // nothing at all when there is nothing true to say.
    rationale: grounded ? rationale : composeRationale(tally),
    action,
    act,
    scene,
    blockIds,
  };
}

/** The real band counts across the recommended speeches. One query, because the
 * agent's claim has to be checked against something. */
async function speechTally(
  blockIds: string[],
  userId: string,
): Promise<SpeechTally> {
  if (blockIds.length === 0) return { beats: 0, solid: 0, close: 0, dry: 0 };
  const result = await DbClient.getPool().query(
    `SELECT count(*) AS beats,
            count(*) FILTER (WHERE m.band = 'solid') AS solid,
            count(*) FILTER (WHERE m.band = 'close') AS close,
            count(*) FILTER (WHERE m.band = 'dry') AS dry
       FROM lines l
       LEFT JOIN line_mastery m ON m.line_id = l.id AND m.user_id = $2
      WHERE l.block_id = ANY($1::uuid[])`,
    [blockIds, userId],
  );
  const row = result.rows[0] ?? {};
  // `pg` returns 64-bit counts as strings.
  return {
    beats: Number(row.beats ?? 0),
    solid: Number(row.solid ?? 0),
    close: Number(row.close ?? 0),
    dry: Number(row.dry ?? 0),
  };
}

async function store(
  rec: ValidRecommendation,
  scope: { userId: string; playId: string; sessionId?: string },
  turns: AgentTurn[],
): Promise<CoachRecommendation> {
  const result = await DbClient.getPool().query(
    `INSERT INTO coach_recommendation
       (user_id, play_id, session_id, note, rationale, action, act, scene,
        block_ids, tool_calls)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[], $10::jsonb)
     RETURNING id`,
    [
      scope.userId,
      scope.playId,
      scope.sessionId ?? null,
      rec.note,
      // NULL rather than '' when the model gave none: "not recorded" is the
      // truth, and an empty string would read as a rationale it declined to
      // give. Migration 012 makes the column nullable for exactly this.
      rec.rationale || null,
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
    rationale: rec.rationale,
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
