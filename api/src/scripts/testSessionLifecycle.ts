// Drives start -> recordBlock -> complete against the real database, asserts
// every row that should land, and then deletes everything it made.
//
// This covers the half of the session loop a person cannot: the SQL underneath
// a rehearsal, which someone running a scene would only ever see through the
// wrap-up. The other half needs a microphone and a human, and no script can
// stand in for it. A real rehearsal proves the mic; this proves the writes.
//
// It uses a throwaway user and removes it afterwards, so it can be run against
// the shared dev/production database without leaving anything behind.
//
// No Transcribe and no Nova: the coaching is synthetic, because what is under
// test is what happens to a judgement once it exists, not how it was reached.
// It does make one real Titan call, since embedding a mistake is part of the
// write path and the whole point of mistake_log having a vector column.
//
// Usage:
//   deno task test-session-lifecycle

import { DbClient } from "../clients/cockroach-db/dbClient.ts";
import { SessionLifecycle } from "../features/sessions/lifecycle.ts";
import type { BlockCoaching } from "../features/coaching/types.ts";

const CHECKS: [string, boolean][] = [];
function check(label: string, ok: boolean) {
  CHECKS.push([label, ok]);
}

async function main() {
  const pool = DbClient.getPool();

  // A block with several beats, and the scene it lives in.
  const blockRow = await pool.query(
    `SELECT l.block_id, l.play_id, l.act, l.scene, ls.character_id
       FROM lines l
       JOIN line_speakers ls ON ls.line_id = l.id
      GROUP BY l.block_id, l.play_id, l.act, l.scene, ls.character_id
     HAVING count(*) >= 3
      LIMIT 1`,
  );
  if (blockRow.rows.length === 0) throw new Error("No multi-beat block found.");
  const { block_id, play_id, act, scene, character_id } = blockRow.rows[0];

  const beatRows = await pool.query(
    `SELECT id, text FROM lines WHERE block_id = $1 ORDER BY beat_number`,
    [block_id],
  );
  const beats = beatRows.rows as { id: string; text: string }[];

  // Just a UUID, with no row behind it. There is no `users` table to insert
  // into since migration 011 — identity lives in Supabase, and `user_id` holds
  // an id minted there. Nothing in the session path looks the owner up, it only
  // records and filters by them, so an id that belongs to no real account is
  // exactly what a throwaway probe wants: no account to create, none to clean
  // up, and no chance of colliding with a real actor's history.
  const userId = crypto.randomUUID();
  console.log(`throwaway user ${userId}\n`);

  let sessionId: string | undefined;
  let drillSessionId: string | undefined;
  try {
    // --- start ---------------------------------------------------------
    const started = await SessionLifecycle.start({
      userId,
      playId: play_id,
      act,
      scene,
      characterId: character_id,
    });
    sessionId = started.sessionId;

    const planned = await pool.query(
      `SELECT count(*) n FROM session_block WHERE session_id = $1`,
      [sessionId],
    );
    const history = await pool.query(
      `SELECT scope, beats_run, completed_at FROM session_history WHERE id = $1`,
      [sessionId],
    );
    check("session row exists", history.rows.length === 1);
    check("scope defaults to scene", history.rows[0]?.scope === "scene");
    check("beats_run starts at 0", Number(history.rows[0]?.beats_run) === 0);
    check("intent recorded", Number(planned.rows[0].n) > 0);
    check("not yet completed", history.rows[0]?.completed_at === null);
    console.log(
      `start      session=${sessionId} blocks=${planned.rows[0].n}`,
    );

    // --- recordBlock ---------------------------------------------------
    // One solid, one dry with words (the case that gets embedded), one dry and
    // silent (the case that must not be).
    const coaching: BlockCoaching = {
      blockId: block_id,
      source: "bedrock",
      note: "The turn in the middle is where it goes.",
      beats: [
        { lineId: beats[0].id, confidence: 0.95, band: "solid" },
        { lineId: beats[1].id, confidence: 0.2, band: "dry" },
        { lineId: beats[2].id, confidence: 0, band: "dry" },
      ],
    };
    const heard = new Map([
      [beats[0].id, "roughly what was written"],
      [beats[1].id, "something else entirely about the weather"],
      [beats[2].id, ""],
    ]);

    await SessionLifecycle.recordBlock({
      sessionId,
      userId,
      coaching,
      heardByLineId: heard,
    });

    const scores = await pool.query(
      `SELECT line_id, confidence_score, heard FROM session_beat_score WHERE session_id = $1`,
      [sessionId],
    );
    const mistakes = await pool.query(
      `SELECT line_id, what_was_said, embedding IS NOT NULL AS embedded
         FROM mistake_log WHERE session_id = $1`,
      [sessionId],
    );
    const notes = await pool.query(
      `SELECT note FROM block_coaching WHERE session_id = $1`,
      [sessionId],
    );
    const mastery = await pool.query(
      `SELECT line_id, confidence_score, mistake_count FROM line_mastery WHERE user_id = $1`,
      [userId],
    );
    const afterRecord = await pool.query(
      `SELECT beats_run FROM session_history WHERE id = $1`,
      [sessionId],
    );

    check("a score per beat", scores.rows.length === 3);
    check(
      "silence stored as empty string, not null",
      scores.rows.some((r: { heard: string }) => r.heard === ""),
    );
    check("only dry beats logged as mistakes", mistakes.rows.length === 2);
    check("block note stored", notes.rows[0]?.note?.length > 0);
    check("mastery upserted per beat", mastery.rows.length === 3);
    check(
      "mistake_count only for dry",
      mastery.rows.filter((r: { mistake_count: number }) =>
        Number(r.mistake_count) === 1
      ).length === 2,
    );
    check("beats_run recomputed", Number(afterRecord.rows[0].beats_run) === 3);

    const spoken = mistakes.rows.find((r: { what_was_said: string }) =>
      r.what_was_said.length > 0
    );
    const silent = mistakes.rows.find((r: { what_was_said: string }) =>
      r.what_was_said.length === 0
    );
    check("a spoken mistake is embedded", spoken?.embedded === true);
    // Not an oversight: a blank has no content to cluster on, and embedding the
    // expected text instead would mix two different meanings into one vector
    // space. "What kind of line does she dry on" is `lines.embedding`'s job.
    check("a silent mistake is not embedded", silent?.embedded === false);

    console.log(
      `record     scores=${scores.rows.length} mistakes=${mistakes.rows.length} ` +
        `embedded=${
          mistakes.rows.filter((r: { embedded: boolean }) => r.embedded).length
        }`,
    );

    // --- idempotence ---------------------------------------------------
    await SessionLifecycle.recordBlock({
      sessionId,
      userId,
      coaching,
      heardByLineId: heard,
    });
    const rescored = await pool.query(
      `SELECT count(*) n FROM session_beat_score WHERE session_id = $1`,
      [sessionId],
    );
    check(
      "re-running a block upserts rather than duplicating",
      Number(rescored.rows[0].n) === 3,
    );

    // --- complete ------------------------------------------------------
    const completed = await SessionLifecycle.complete({
      sessionId,
      userId,
      durationSeconds: 214,
    });
    const finalRow = await pool.query(
      `SELECT duration_seconds, completed_at FROM session_history WHERE id = $1`,
      [sessionId],
    );
    check("duration stored", Number(finalRow.rows[0].duration_seconds) === 214);
    // The session planned every block of the scene and only one was run, so it
    // is genuinely unfinished, completed_at must stay NULL. This is the check
    // that would fail if `completed` were derived from "did complete() get
    // called" rather than from what actually happened.
    check(
      "an unfinished run is not marked complete",
      finalRow.rows[0].completed_at === null && completed.completed === false,
    );
    console.log(
      `complete   ran=${completed.beatsRun}/${completed.beatsPlanned} ` +
        `completed=${completed.completed}`,
    );
    // --- a block-scoped drill ----------------------------------------
    // What "Practice these lines" now starts: a session over a chosen subset of
    // her speeches rather than the whole scene. The point of migration 008,
    // finishing three speeches is a completed rehearsal, not a scene abandoned
    // after three.
    const drill = await SessionLifecycle.start({
      userId,
      playId: play_id,
      act,
      scene,
      characterId: character_id,
      scope: "blocks",
      blockIds: [block_id],
      source: "user",
    });
    drillSessionId = drill.sessionId;

    const drillRow = await pool.query(
      `SELECT scope FROM session_history WHERE id = $1`,
      [drillSessionId],
    );
    const drillBlocks = await pool.query(
      `SELECT block_id, source FROM session_block WHERE session_id = $1`,
      [drillSessionId],
    );
    check("a drill is scoped to blocks", drillRow.rows[0]?.scope === "blocks");
    check(
      "a drill records only the blocks it was given",
      drillBlocks.rows.length === 1 &&
        drillBlocks.rows[0].block_id === block_id,
    );
    check("who chose them is recorded", drillBlocks.rows[0]?.source === "user");

    // A block she doesn't speak must be refused rather than dropped, a session
    // whose intent quietly shrank would report itself finished having run less
    // than it was asked to.
    let refused = false;
    try {
      await SessionLifecycle.start({
        userId,
        playId: play_id,
        act,
        scene,
        characterId: character_id,
        scope: "blocks",
        blockIds: [crypto.randomUUID()],
        source: "user",
      });
    } catch {
      refused = true;
    }
    check("a block she doesn't speak is refused, not dropped", refused);
    console.log(`drill       scope=blocks blocks=${drillBlocks.rows.length}`);
  } finally {
    // Children before parents, and both sessions before either parent row,
    // getting this backwards is what the failed first run of this probe proved,
    // by leaving a session behind that its own mistake_log rows still pointed at.
    const sessions = [drillSessionId, sessionId].filter(Boolean) as string[];
    for (const id of sessions) {
      await pool.query(`DELETE FROM mistake_log WHERE session_id = $1`, [id]);
      await pool.query(`DELETE FROM session_beat_score WHERE session_id = $1`, [
        id,
      ]);
      await pool.query(`DELETE FROM block_coaching WHERE session_id = $1`, [
        id,
      ]);
      await pool.query(`DELETE FROM session_block WHERE session_id = $1`, [id]);
    }
    for (const id of sessions) {
      await pool.query(`DELETE FROM session_history WHERE id = $1`, [id]);
    }
    await pool.query(`DELETE FROM line_mastery WHERE user_id = $1`, [userId]);
    console.log(`\ncleaned up user ${userId}`);
  }
}

if (import.meta.main) {
  await main();

  console.log("\n--- checks ---");
  let failed = 0;
  for (const [label, ok] of CHECKS) {
    if (!ok) failed++;
    console.log(`  ${ok ? "OK  " : "FAIL"} ${label}`);
  }
  Deno.exit(failed === 0 ? 0 : 1);
}
