/**
 * What the coach agent is allowed to look at.
 *
 * Every one of these reads her actual history. None of them takes text from the
 * model and puts it in a query, the agent chooses *which* question to ask and
 * with which ids, and the SQL is fixed here. That matters more than usual for an
 * agent: the model is choosing the calls, so the calls have to be safe
 * individually rather than safe in the sequence someone imagined.
 *
 * They are also all scoped to one user and one play by arguments the *caller*
 * supplies, not the model. The model can ask "what has she missed"; it cannot
 * ask "what has anyone missed".
 */

import { DbClient } from "../../clients/cockroach-db/dbClient.ts";
import type { AgentTool } from "../../clients/bedrock-client/bedrockClient.ts";

export interface ToolScope {
  userId: string;
  playId: string;
  characterId: string;
}

/**
 * How many rows any one tool may return.
 *
 * Small on purpose. Everything here goes back into the model's context and is
 * paid for on every subsequent turn of the loop, and a coach that has read forty
 * flagged lines writes a worse note than one that has read six; the job is to
 * name the thing worth naming, which is a different task from summarising
 * everything.
 */
const TOOL_ROW_LIMIT = 8;

export function buildCoachTools(scope: ToolScope): AgentTool[] {
  const { userId, playId, characterId } = scope;
  const pool = () => DbClient.getPool();

  return [
    {
      name: "get_part_progress",
      description:
        "How much of this part she has. Returns total beats, beats attempted, " +
        "and beats currently solid, plus a per-scene breakdown of what she has " +
        "run and whether she finished it.",
      schema: { type: "object", properties: {} },
      run: async () => {
        const totals = await pool().query(
          `SELECT count(*) AS total,
                  count(m.line_id) AS practised,
                  count(*) FILTER (WHERE m.band = 'solid') AS solid
             FROM lines l
             JOIN line_speakers ls ON ls.line_id = l.id AND ls.character_id = $2
             LEFT JOIN line_mastery m ON m.line_id = l.id AND m.user_id = $3
            WHERE l.play_id = $1`,
          [playId, characterId, userId],
        );

        // Per scene: how much of her part is there, how much she has scored,
        // and whether any run of it was ever finished. "Never run" and "run but
        // never completed" are different notes to give.
        const scenes = await pool().query(
          `SELECT l.act, l.scene,
                  count(*) AS beats,
                  count(sbs.line_id) AS beats_run,
                  bool_or(sh.completed_at IS NOT NULL) AS ever_completed
             FROM lines l
             JOIN line_speakers ls ON ls.line_id = l.id AND ls.character_id = $2
             LEFT JOIN session_beat_score sbs ON sbs.line_id = l.id
             LEFT JOIN session_history sh
                    ON sh.id = sbs.session_id AND sh.user_id = $3
            WHERE l.play_id = $1
            GROUP BY l.act, l.scene
            ORDER BY min(l.act_order), min(l.scene_order)`,
          [playId, characterId, userId],
        );

        return {
          totalBeats: Number(totals.rows[0].total),
          practisedBeats: Number(totals.rows[0].practised),
          solidBeats: Number(totals.rows[0].solid),
          scenes: scenes.rows.map((r: Record<string, unknown>) => ({
            act: r.act,
            scene: r.scene,
            beats: Number(r.beats),
            beatsRun: Number(r.beats_run),
            everCompleted: r.ever_completed === true,
          })),
        };
      },
    },

    {
      name: "get_recent_misses",
      description:
        "The beats she keeps getting wrong, worst first. Includes what she " +
        "actually said instead, how many times she has missed each one, and " +
        "the shape of the whole speech it belongs to (how many of its beats " +
        "are solid, close and dry) so you can say why that speech is worth " +
        "running rather than just which line failed.",
      schema: { type: "object", properties: {} },
      run: async () => {
        const result = await pool().query(
          // The per-speech tally is a correlated aggregate over *every* beat of
          // the block, not only the missed ones — "two of its nine beats are
          // dry" needs the nine. Counting solid explicitly rather than as
          // "not dry and not close": a beat only ever scored by the
          // deterministic fallback has a NULL band and belongs in none of the
          // three (migration 009).
          `SELECT l.id AS line_id, l.act, l.scene, l.text, l.block_id,
                  m.mistake_count, m.band,
                  coalesce(recent.what_was_said, '') AS what_was_said,
                  speech.solid, speech.close, speech.dry, speech.beats
             FROM line_mastery m
             JOIN lines l ON l.id = m.line_id
             JOIN line_speakers ls ON ls.line_id = l.id AND ls.character_id = $2
             LEFT JOIN LATERAL (
               SELECT ml.what_was_said FROM mistake_log ml
                WHERE ml.line_id = m.line_id AND ml.user_id = m.user_id
                ORDER BY ml.created_at DESC LIMIT 1
             ) recent ON true
             LEFT JOIN LATERAL (
               SELECT count(*) AS beats,
                      count(*) FILTER (WHERE bm.band = 'solid') AS solid,
                      count(*) FILTER (WHERE bm.band = 'close') AS close,
                      count(*) FILTER (WHERE bm.band = 'dry') AS dry
                 FROM lines bl
                 LEFT JOIN line_mastery bm
                        ON bm.line_id = bl.id AND bm.user_id = m.user_id
                WHERE bl.block_id = l.block_id
             ) speech ON true
            WHERE m.user_id = $3 AND l.play_id = $1 AND m.mistake_count > 0
            ORDER BY m.mistake_count DESC, m.confidence_score ASC
            LIMIT $4`,
          [playId, characterId, userId, TOOL_ROW_LIMIT],
        );
        return result.rows.map((r: Record<string, unknown>) => ({
          lineId: r.line_id,
          act: r.act,
          scene: r.scene,
          written: r.text,
          // Empty means she said nothing at all, which is a different failure
          // from saying the wrong thing and worth a different note.
          heard: r.what_was_said,
          timesMissed: Number(r.mistake_count),
          band: r.band,
          // The speech this beat belongs to. `speech` is what a rationale is
          // built from: it says whether one line went or the whole thing is
          // shaky, which are different problems and different advice.
          speech: {
            blockId: r.block_id,
            beats: Number(r.beats ?? 0),
            solid: Number(r.solid ?? 0),
            close: Number(r.close ?? 0),
            dry: Number(r.dry ?? 0),
          },
        }));
      },
    },

    {
      name: "find_similar_beats",
      description:
        "Given a line she missed, find other beats in her part that are " +
        "similar in meaning — not in wording. Use this to tell whether a " +
        "mistake is isolated or a pattern.",
      schema: {
        type: "object",
        properties: {
          lineId: {
            type: "string",
            description: "A lineId from get_recent_misses.",
          },
        },
        required: ["lineId"],
      },
      run: async (input) => {
        const lineId = String(input.lineId ?? "");
        // The probe vector is fetched and then bound as a parameter on the
        // next statement. `ORDER BY embedding <-> (SELECT …)` plans as a full
        // scan with no error and no warning. See migration 007. This is the
        // one query in the app where that distinction is load-bearing.
        const probe = await pool().query(
          `SELECT embedding::TEXT AS vec FROM lines
            WHERE id = $1 AND embedding IS NOT NULL`,
          [lineId],
        );
        if (probe.rows.length === 0) {
          return { error: "That line has no embedding.", similar: [] };
        }

        const near = await pool().query(
          `SELECT l.id AS line_id, l.act, l.scene, l.text,
                  (l.embedding <-> $1::VECTOR) AS distance,
                  coalesce(m.mistake_count, 0) AS mistake_count
             FROM lines l
             JOIN line_speakers ls ON ls.line_id = l.id AND ls.character_id = $2
             LEFT JOIN line_mastery m ON m.line_id = l.id AND m.user_id = $4
            WHERE l.id <> $3 AND l.embedding IS NOT NULL
            ORDER BY l.embedding <-> $1::VECTOR
            LIMIT 5`,
          [probe.rows[0].vec, characterId, lineId, userId],
        );

        return {
          // Distances are reported rather than hidden, and the guidance for
          // reading them is measured over this corpus: unrelated beats average
          // 1.32 apart and a beat's nearest neighbour averages 0.99, so
          // anything near 1.3 is noise wearing a number.
          // Numbers, not sentences, same reason as get_last_recommendation
          // above. The model needs the scale to read a distance; it must not be
          // handed a phrase it might quote back to her.
          scale: {
            unrelatedAverage: 1.32,
            nearestNeighbourAverage: 0.99,
            similarBelow: 1,
          },
          similar: near.rows.map((r: Record<string, unknown>) => ({
            lineId: r.line_id,
            act: r.act,
            scene: r.scene,
            written: r.text,
            distance: Number(Number(r.distance).toFixed(3)),
            timesMissed: Number(r.mistake_count),
          })),
        };
      },
    },

    {
      name: "submit_recommendation",
      description:
        "Give your answer. Call this exactly once, when you have decided. " +
        "This ends your turn — do not also reply in prose.",
      terminal: true,
      schema: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description:
              "One or two sentences for the actor, quoting the line you mean.",
          },
          observation: {
            type: "string",
            description:
              "What has actually been happening to that line — how often she " +
              "has missed it, or what she said instead. No quotation, just the " +
              "fact. Required.",
          },
          advice: {
            type: "string",
            description:
              "What she should do about it, in one short sentence. No " +
              "quotation. Required.",
          },
          rationale: {
            type: "string",
            description:
              "Why this speech and not another, in terms of her marks. Take " +
              "every number from the `speech` object on the beat you chose in " +
              "get_recent_misses — its beats/solid/close/dry — and use those " +
              "figures. No example is given here on purpose: the last one was " +
              "copied verbatim and shipped counts that were not hers. " +
              "Required.",
          },
          action: {
            type: "string",
            enum: ["none", "drill", "scene"],
            description:
              "'drill' to re-run specific speeches, 'scene' for a whole scene, " +
              "'none' when there is nothing worth saying.",
          },
          lineIds: {
            type: "array",
            items: { type: "string" },
            description: "For 'drill': lineIds from get_recent_misses.",
          },
          act: { type: "string", description: "For 'scene'." },
          scene: { type: "string", description: "For 'scene'." },
        },
        required: ["note", "observation", "advice", "rationale", "action"],
      },
      // Never runs: the loop returns its arguments as the answer the moment the
      // model calls it.
      run: () => Promise.resolve({}),
    },

    {
      name: "get_last_recommendation",
      description:
        "What you told her to do last time, and whether she did it. Use this " +
        "before recommending, so you can acknowledge it rather than repeat it.",
      schema: { type: "object", properties: {} },
      run: async () => {
        const result = await pool().query(
          `SELECT id, note, action, act, scene, block_ids, created_at,
                  followed_session_id IS NOT NULL AS followed
             FROM coach_recommendation
            WHERE user_id = $1 AND play_id = $2
            ORDER BY created_at DESC
            LIMIT 1`,
          [userId, playId],
        );
        // No human-readable sentence anywhere in this tool's output. The first
        // version returned `note: "You have not advised her before."` as
        // guidance for the model, and the model relayed it to the actor
        // verbatim, "You have not been advised before" opened a real
        // recommendation. Tool results are data; anything phrased like prose
        // will eventually be repeated as prose.
        if (result.rows.length === 0) return { previous: null };
        const row = result.rows[0];

        // Whether she did it is derived rather than trusted: a session that
        // covered the recommended blocks counts, however she got there, she
        // might have run the whole scene instead of the drill, which is
        // following the advice by a better route.
        const blockIds: string[] = row.block_ids ?? [];
        let covered = 0;
        if (blockIds.length > 0) {
          const ran = await pool().query(
            `SELECT count(DISTINCT l.block_id) AS n
               FROM session_beat_score sbs
               JOIN lines l ON l.id = sbs.line_id
               JOIN session_history sh ON sh.id = sbs.session_id
              WHERE sh.user_id = $1 AND sh.started_at > $2
                AND l.block_id = ANY($3::uuid[])`,
            [userId, row.created_at, blockIds],
          );
          covered = Number(ran.rows[0].n);
        }

        return {
          previous: {
            said: row.note,
            action: row.action,
            act: row.act,
            scene: row.scene,
            speechesRecommended: blockIds.length,
            speechesSheRanSince: covered,
            followed: blockIds.length > 0 && covered >= blockIds.length,
          },
        };
      },
    },
  ];
}
