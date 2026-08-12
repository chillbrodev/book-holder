// Fills `band` on beats that were scored before the column existed, or scored
// while Bedrock was unreachable.
//
// Migration 009 stores the band the model returns, because two screens need it
// and the two threshold cuts that would let them derive it are deliberately
// unset (`OPEN_ITEMS.md` §1a). Rows written before that migration have the
// score and not the judgement.
//
// This is a **re-score, not a reconstruction**. `session_beat_score.heard` holds
// exactly what she said, and `lines.text` holds what was written, so the same
// (expected, heard) pairs go back through the same rubric and the same model.
// Nothing is inferred from the stored number — deriving a band from
// `confidence_score` is precisely the thing that would require inventing the
// cuts, and is why this script exists instead.
//
// Safe to re-run: it only selects rows where `band IS NULL`, and only where a
// transcript was stored. A beat she was silent through has nothing to re-score
// and is left alone — it is already `dry` at confidence 0 by the rule in
// `coaching/service.ts`, and its band is filled from that below rather than by
// asking the model to judge an empty string.
//
// Bills one Nova call per block. Dry run unless --yes, like every other script
// here that spends money.
//
// Usage:
//   deno task backfill-bands
//   deno task backfill-bands -- --yes

import { DbClient } from "../clients/cockroach-db/dbClient.ts";
import { CoachingService } from "../features/coaching/service.ts";
import type { BeatAttempt } from "../features/coaching/service.ts";

interface Row {
  session_id: string;
  block_id: string;
  play_title: string;
  character_name: string;
  line_id: string;
  beat_number: number | string;
  expected: string;
  heard: string;
}

if (import.meta.main) {
  const yes = Deno.args.includes("--yes");
  const pool = DbClient.getPool();

  const result = await pool.query(
    `SELECT sbs.session_id, l.block_id, p.title AS play_title,
            c.name AS character_name,
            l.id AS line_id, l.beat_number, l.text AS expected, sbs.heard
       FROM session_beat_score sbs
       JOIN lines l ON l.id = sbs.line_id
       JOIN plays p ON p.id = l.play_id
       JOIN session_history sh ON sh.id = sbs.session_id
       JOIN characters c ON c.play_id = p.id
       JOIN line_speakers ls ON ls.line_id = l.id AND ls.character_id = c.id
      WHERE sbs.band IS NULL
      ORDER BY sh.started_at, l.line_number`,
  );
  const rows = result.rows as Row[];

  // Grouped by (session, block) because that is the unit the coach is called
  // on — a beat judged without the rest of its speech is the thing
  // `coaching-plan.md` §2 exists to avoid.
  const blocks = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.session_id}|${row.block_id}`;
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key)!.push(row);
  }

  const silent = rows.filter((r) => r.heard.trim() === "").length;
  console.log(`unbanded beats: ${rows.length} across ${blocks.size} block(s)`);
  console.log(`  ${silent} of them are silences — banded dry without a call`);
  console.log(`  ~${blocks.size} Nova call(s)`);

  if (rows.length === 0) {
    console.log("\nNothing to do.");
    Deno.exit(0);
  }
  if (!yes) {
    console.log(
      "\nDry run — nothing called, nothing written. --yes to run it.",
    );
    Deno.exit(0);
  }

  let banded = 0;
  let failed = 0;

  for (const [key, beats] of blocks) {
    const [sessionId, blockId] = key.split("|");
    const attempts: BeatAttempt[] = beats.map((b) => ({
      lineId: b.line_id,
      beatNumber: Number(b.beat_number),
      expected: b.expected,
      heard: b.heard,
    }));

    const coaching = await CoachingService.coachBlock({
      blockId,
      playTitle: beats[0].play_title,
      characterName: beats[0].character_name,
      beats: attempts,
    });

    if (coaching.source === "fallback") {
      // The fallback cannot see *close*, so writing its band would put a
      // judgement in the column that nothing actually made — the same reason
      // `lifecycle.ts` writes NULL for it. Leave the rows and say so.
      failed += beats.length;
      console.error(
        `  block ${blockId.slice(0, 8)}: Bedrock unavailable, left unbanded`,
      );
      continue;
    }

    for (const beat of coaching.beats) {
      await pool.query(
        `UPDATE session_beat_score SET band = $3
          WHERE session_id = $1 AND line_id = $2`,
        [sessionId, beat.lineId, beat.band],
      );
      banded++;
    }
    console.log(
      `  block ${blockId.slice(0, 8)}: ${
        coaching.beats.map((b) => b.band).join(", ")
      }`,
    );
  }

  // `line_mastery.band` is the *latest* judgement for a beat, matching
  // `confidence_score` on the same row — so it takes the band from the most
  // recent session that scored it, not from whichever block happened to be
  // processed last above.
  const propagated = await pool.query(
    `UPDATE line_mastery m
        SET band = latest.band
       FROM (
         SELECT DISTINCT ON (sbs.line_id, sh.user_id)
                sbs.line_id, sh.user_id, sbs.band
           FROM session_beat_score sbs
           JOIN session_history sh ON sh.id = sbs.session_id
          WHERE sbs.band IS NOT NULL
          ORDER BY sbs.line_id, sh.user_id, sh.started_at DESC
       ) latest
      WHERE m.line_id = latest.line_id AND m.user_id = latest.user_id
        AND m.band IS DISTINCT FROM latest.band`,
  );

  console.log(
    `\nbanded ${banded} beat(s)${
      failed > 0 ? `, ${failed} left unbanded` : ""
    }`,
  );
  console.log(`line_mastery rows updated: ${propagated.rowCount}`);
  Deno.exit(failed === 0 ? 0 : 1);
}
