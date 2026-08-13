/**
 * The session as a thing with a beginning, a middle and an end, rather than a
 * single write at the end of a scene.
 *
 * `docs/coaching-plan.md` §6, amended by migration 008. Three moments:
 *
 *   start()       a row exists before she says anything, with the blocks she
 *                 means to run recorded as intent
 *   recordBlock() one block's judgement lands as it happens
 *   complete()    the run is marked finished, as distinct from abandoned
 *
 * ## Why not one transaction at the end
 *
 * That is what `SessionService.saveSession` does today, and coaching cannot use
 * it. Scores arrive per block, seconds apart, and each one now carries a
 * Bedrock round trip behind it, so the end-of-scene shape was about to become
 * a loop of network calls inside an open serializable transaction, on a
 * database where serializable is the only level there is.
 *
 * It also fixes something already broken: today, abandoning a scene loses the
 * entire run. Incremental writes mean a partial rehearsal is still a rehearsal,
 * which is the whole premise of migration 008's block-scoped sessions.
 *
 * ## Embeddings happen outside the transaction, deliberately
 *
 * `recordBlock` embeds what she said *before* opening its transaction, for the
 * exact reason above. A Titan call is ~200ms; holding a serializable
 * transaction open across it, per block, for the length of a scene, is how this
 * would start producing retries under any concurrency at all.
 */

import type { PoolClient } from "pg";
import { DbClient } from "../../clients/cockroach-db/dbClient.ts";
import { EmbeddingsClient } from "../../clients/bedrock-client/embeddingsClient.ts";
import { SessionError } from "./errors.ts";
import type { BlockCoaching } from "../coaching/types.ts";

export type SessionScope = "scene" | "blocks";

export interface StartSessionInput {
  userId: string;
  playId: string;
  act: string;
  scene: string;
  characterId: string;
  /** Defaults to the whole scene, which is what the existing rehearsal route
   * starts. */
  scope?: SessionScope;
  /** Required for `scope: "blocks"`, ignored otherwise. */
  blockIds?: string[];
  /** Who chose these blocks. `coach` is what makes a recommendation checkable
   * later. See migration 008. */
  source?: "user" | "coach";
}

export const SessionLifecycle = {
  /**
   * Open a session and record what it set out to cover.
   *
   * The block list is resolved server-side from (play, act, scene, character)
   * rather than taken from the client, for the same reason `saveSession` loads
   * the expected text itself: the set of blocks she is responsible for is part
   * of the answer key. A client that could name its own blocks could name none.
   */
  async start(input: StartSessionInput): Promise<{ sessionId: string }> {
    const { userId, playId, act, scene, characterId } = input;
    const scope = input.scope ?? "scene";

    if (
      !playId?.trim() || !act?.trim() || !scene?.trim() || !characterId?.trim()
    ) {
      throw new SessionError(
        "VALIDATION_ERROR",
        "playId, act, scene and characterId are all required.",
      );
    }
    if (scope === "blocks" && !input.blockIds?.length) {
      throw new SessionError(
        "VALIDATION_ERROR",
        "scope 'blocks' needs at least one blockId.",
      );
    }

    // Ordered by where the block first appears in the scene, so `ordinal`
    // matches reading order for a scene run. A drill set keeps the order the
    // caller asked for instead, worst-first is a legitimate thing for the
    // coach to want, and re-sorting it into script order would throw that away.
    const blocks = await DbClient.getPool().query(
      `SELECT l.block_id, min(l.line_number) AS first_line
         FROM lines l
         JOIN line_speakers ls ON ls.line_id = l.id AND ls.character_id = $4
        WHERE l.play_id = $1 AND l.act = $2 AND l.scene = $3
        GROUP BY l.block_id
        ORDER BY first_line`,
      [playId, act, scene, characterId],
    );

    const available: string[] = blocks.rows.map((row: { block_id: string }) =>
      row.block_id
    );
    if (available.length === 0) {
      throw new SessionError(
        "SCENE_NOT_FOUND",
        `No blocks for character ${characterId} in ${act}.${scene}.`,
      );
    }

    let chosen: string[];
    if (scope === "blocks") {
      const allowed = new Set(available);
      // A block she doesn't speak, or one from another scene, is rejected
      // rather than silently dropped: a session whose intent quietly shrank
      // would report itself complete having run less than it was asked to.
      const unknown = input.blockIds!.filter((id) => !allowed.has(id));
      if (unknown.length > 0) {
        throw new SessionError(
          "VALIDATION_ERROR",
          `${unknown.length} block(s) are not ${characterId}'s in ${act}.${scene}.`,
        );
      }
      chosen = [...new Set(input.blockIds!)];
    } else {
      chosen = available;
    }

    return await DbClient.withTransaction(async (client) => {
      const session = await client.query(
        // beats_run starts at 0 and counts up. Migration 006's header records
        // the third state this creates: NULL still means "written before the
        // column existed", 0 now means "in progress", not "ran none".
        `INSERT INTO session_history (user_id, play_id, act, scene_range, scope, beats_run)
         VALUES ($1, $2, $3, $4, $5, 0)
         RETURNING id`,
        [userId, playId, act, scene, scope],
      );
      const sessionId: string = session.rows[0].id;

      for (const [ordinal, blockId] of chosen.entries()) {
        await client.query(
          `INSERT INTO session_block (session_id, block_id, source, ordinal)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (session_id, block_id) DO NOTHING`,
          [sessionId, blockId, input.source ?? "user", ordinal],
        );
      }

      return { sessionId };
    });
  },

  /**
   * One block's judgement, written as it happens.
   *
   * Called from the capture socket after coaching. Returns silently for a
   * session that isn't hers or doesn't exist; the socket is auth-aware but not
   * auth-gated (§7), so "no session to write to" is the guest's normal path and
   * not an error worth failing a rehearsal over.
   */
  async recordBlock(input: {
    sessionId: string;
    userId: string;
    coaching: BlockCoaching;
    /** What she actually said, per beat. Index-independent, keyed by lineId. */
    heardByLineId: Map<string, string>;
  }): Promise<void> {
    const { sessionId, userId, coaching, heardByLineId } = input;

    const owned = await DbClient.getPool().query(
      `SELECT 1 FROM session_history WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
    if (owned.rows.length === 0) return;

    // Only *dry* beats are logged as mistakes. §3 is explicit that *close*,
    // "she had the sense of it, not the words", is the normal case with
    // Shakespeare and is not a failure; logging it would bury the signal
    // mistake_log exists for under the thing that happens most.
    const dryBeats = coaching.beats.filter((beat) => beat.band === "dry");

    // Embedded before the transaction opens, never inside it. See the header.
    // Only what she actually *said* is embedded: a blank has no content to
    // cluster on, and embedding the expected text instead would mix "what she
    // said" and "what she should have said" into one vector space and return
    // misleading neighbours. Blanks are still findable, `what_was_said = ''`,
    // and the "what kind of line does she dry on" question is answered by
    // `lines.embedding`, which is populated for every beat.
    const embeddings = new Map<string, string>();
    await Promise.all(dryBeats.map(async (beat) => {
      const said = (heardByLineId.get(beat.lineId) ?? "").trim();
      if (said.length === 0) return;
      try {
        const vector = await EmbeddingsClient.embed(said);
        embeddings.set(beat.lineId, EmbeddingsClient.toVectorLiteral(vector));
      } catch (err) {
        // A missing embedding costs a row its place in semantic search and
        // nothing else. Losing the mistake itself would be worse.
        console.error(`Could not embed mistake for line ${beat.lineId}:`, err);
      }
    }));

    await DbClient.withTransaction(async (client) => {
      for (const beat of coaching.beats) {
        const said = heardByLineId.get(beat.lineId) ?? "";

        await client.query(
          `INSERT INTO session_beat_score (session_id, line_id, confidence_score, heard, band)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (session_id, line_id) DO UPDATE
             SET confidence_score = $3, heard = $4, band = $5, created_at = now()`,
          // NULL when the fallback scored this beat: word recall can see solid
          // and dry and is blind to *close*, so it must not assert a band it
          // cannot know (migration 009).
          [
            sessionId,
            beat.lineId,
            beat.confidence,
            said,
            bandOrNull(coaching, beat),
          ],
        );

        // confidence_score is the *latest* judgement, not a running average: it
        // answers "how well does she know this now". The history lives in
        // mistake_count, which only accumulates. Two columns, two questions.
        await client.query(
          `INSERT INTO line_mastery (user_id, line_id, confidence_score, last_practiced_at, mistake_count, band)
           VALUES ($1, $2, $3, now(), $4, $5)
           ON CONFLICT (user_id, line_id) DO UPDATE
             SET confidence_score = $3,
                 last_practiced_at = now(),
                 mistake_count = line_mastery.mistake_count + $4,
                 band = $5`,
          [
            userId,
            beat.lineId,
            beat.confidence,
            beat.band === "dry" ? 1 : 0,
            bandOrNull(coaching, beat),
          ],
        );
      }

      for (const beat of dryBeats) {
        const said = heardByLineId.get(beat.lineId) ?? "";
        const vector = embeddings.get(beat.lineId) ?? null;
        await client.query(
          `INSERT INTO mistake_log (user_id, line_id, session_id, what_was_said, embedding)
           VALUES ($1, $2, $3, $4, $5::VECTOR)`,
          [userId, beat.lineId, sessionId, said, vector],
        );
      }

      if (coaching.note.trim().length > 0) {
        await client.query(
          `INSERT INTO block_coaching (session_id, block_id, note)
           VALUES ($1, $2, $3)
           ON CONFLICT (session_id, block_id) DO UPDATE SET note = $3`,
          [sessionId, coaching.blockId, coaching.note.trim()],
        );
      }

      await refreshBeatsRun(client, sessionId);
    });
  },

  /**
   * Mark the run finished.
   *
   * "Finished" is now one question for both scopes, which is why migration 008
   * fills `session_block` for a scene run too: every block she meant to run has
   * all of its beats scored. A scene-shaped session and a four-speech drill are
   * the same check.
   */
  async complete(input: {
    sessionId: string;
    userId: string;
    durationSeconds: number;
  }): Promise<{ completed: boolean; beatsRun: number; beatsPlanned: number }> {
    const { sessionId, userId, durationSeconds } = input;

    const planned = await DbClient.getPool().query(
      `SELECT
         (SELECT count(*) FROM lines l
            JOIN session_block sb ON sb.block_id = l.block_id
           WHERE sb.session_id = $1) AS planned,
         (SELECT count(*) FROM session_beat_score WHERE session_id = $1) AS run`,
      [sessionId],
    );
    const beatsPlanned = Number(planned.rows[0]?.planned ?? 0);
    const beatsRun = Number(planned.rows[0]?.run ?? 0);
    const completed = beatsPlanned > 0 && beatsRun >= beatsPlanned;

    const result = await DbClient.getPool().query(
      // completed_at is only ever set, never cleared, and only when she got
      // through what she set out to do. An abandoned session keeps its rows and
      // its NULL; a partial rehearsal is still a rehearsal (§6), it just isn't
      // a finished one.
      `UPDATE session_history
          SET duration_seconds = $3,
              completed_at = CASE WHEN $4 THEN now() ELSE completed_at END
        WHERE id = $1 AND user_id = $2
        RETURNING id`,
      [sessionId, userId, Math.round(durationSeconds), completed],
    );
    if (result.rows.length === 0) {
      throw new SessionError(
        "SESSION_NOT_FOUND",
        "No such session for this user.",
      );
    }

    return { completed, beatsRun, beatsPlanned };
  },
};

/**
 * `beats_run` recomputed from `session_beat_score` rather than incremented.
 *
 * An increment would drift the moment a block is re-run inside the same session
 * , `session_beat_score` upserts on (session_id, line_id), so re-delivering a
 * speech replaces its scores rather than adding to them, and a counter that
 * only ever went up would disagree with the rows underneath it. Counting is
 * cheap and cannot be wrong.
 */
async function refreshBeatsRun(
  client: PoolClient,
  sessionId: string,
): Promise<void> {
  await client.query(
    `UPDATE session_history
        SET beats_run = (SELECT count(*) FROM session_beat_score WHERE session_id = $1)
      WHERE id = $1`,
    [sessionId],
  );
}

/**
 * The model's band, or NULL when it wasn't the model that decided.
 *
 * `BlockCoaching.band` is always one of the three, because the deterministic
 * fallback has to answer something, but word recall can only see *solid* and
 * *dry*, and is structurally blind to *close*, which is the semantic case and
 * the whole reason for using a model. Storing its guess would put a judgement in
 * the database that nothing actually made, and the mastery bar would then count
 * beats as known on the strength of word overlap.
 *
 * NULL means "not banded", never "not solid", so anything counting mastery
 * counts `band = 'solid'` rather than `band <> 'dry'`.
 */
function bandOrNull(
  coaching: BlockCoaching,
  beat: BlockCoaching["beats"][number],
): string | null {
  return coaching.source === "bedrock" ? beat.band : null;
}
