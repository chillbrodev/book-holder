// Drives start -> recordBlock -> complete against the real database, asserts
// every row that should land, and then deletes everything it made.
//
// This is the half of the session loop that `docs/verify-session-loop.md`
// cannot cover, in reverse: that document is the things only a person with a
// microphone can check, and this is the SQL underneath them, which a person
// running a scene would only ever see through the wrap-up. The two are
// complementary — a real rehearsal proves the mic, this proves the writes.
//
// It uses a throwaway user and removes it afterwards, so it can be run against
// the shared dev/production database without leaving anything behind. That
// matters more than usual right now: every memory table is at 0 rows, and the
// first real rehearsal should be the first real row.
//
// No Transcribe and no Nova — the coaching is synthetic, because what is under
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

  const user = await pool.query(
    `INSERT INTO users (username, name) VALUES ($1, $2) RETURNING id`,
    [`lifecycle-probe-${crypto.randomUUID().slice(0, 8)}`, "Lifecycle Probe"],
  );
  const userId: string = user.rows[0].id;
  console.log(`throwaway user ${userId}\n`);

  let sessionId: string | undefined;
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
    // is genuinely unfinished — completed_at must stay NULL. This is the check
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
  } finally {
    // FK order matters: children before parents.
    if (sessionId) {
      await pool.query(`DELETE FROM mistake_log WHERE session_id = $1`, [
        sessionId,
      ]);
      await pool.query(`DELETE FROM session_beat_score WHERE session_id = $1`, [
        sessionId,
      ]);
      await pool.query(`DELETE FROM block_coaching WHERE session_id = $1`, [
        sessionId,
      ]);
      await pool.query(`DELETE FROM session_block WHERE session_id = $1`, [
        sessionId,
      ]);
      await pool.query(`DELETE FROM session_history WHERE id = $1`, [
        sessionId,
      ]);
    }
    await pool.query(`DELETE FROM line_mastery WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
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
