import type { PoolClient } from "pg";
import { getPool } from "./db.js";
import type { BuiltPlay } from "./types.js";

const RETRYABLE_SQLSTATE = "40001";
const CHUNK_SIZE = 500;

/** This is a one-shot seed import (run by hand, not concurrent with anything
 * else), so a bounded retry on serialization conflicts is enough — it doesn't
 * need the full backoff treatment the live per-session write path needs. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if ((err as { code?: string }).code !== RETRYABLE_SQLSTATE) throw err;
      console.warn(`retryable transaction conflict, attempt ${i + 1}/${attempts}`);
    }
  }
  throw lastErr;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Refuses to import a play that is already in the database.
 *
 * Nothing here ever updated in place — a second run just inserted a whole
 * second copy under a new play_id, and the only symptoms were a duplicate on
 * the Shelf and a Polly bill that quietly doubled, because the warm script
 * walks every block it can see. Migration 004 masked this by emptying the
 * table first.
 *
 * Checked inside the caller's transaction so the check and the insert can't be
 * interleaved by a concurrent run.
 */
async function assertNotAlreadyImported(client: PoolClient, title: string): Promise<void> {
  const existing = await client.query(
    "SELECT id, created_at FROM plays WHERE title = $1 ORDER BY created_at",
    [title]
  );
  if (existing.rows.length === 0) return;

  const ids = existing.rows
    .map((r: { id: string; created_at: Date }) => `  ${r.id}  imported ${r.created_at.toISOString()}`)
    .join("\n");
  throw new Error(
    `"${title}" is already imported — refusing to insert a second copy.\n${ids}\n\n` +
      `Delete the existing rows first (child tables before parents: mistake_log,\n` +
      `line_mastery, line_speakers, lines, stage_directions, roles_in_progress,\n` +
      `characters, plays), or re-run with --dry-run to regenerate the review\n` +
      `artifacts without touching the database.`
  );
}

async function insertPlay(client: PoolClient, play: BuiltPlay["play"]): Promise<void> {
  await client.query("INSERT INTO plays (id, title, source_url) VALUES ($1, $2, $3)", [
    play.id,
    play.title,
    play.source_url,
  ]);
}

async function insertCharacters(client: PoolClient, characters: BuiltPlay["characters"]): Promise<void> {
  if (characters.length === 0) return;
  await client.query(
    `INSERT INTO characters (id, play_id, name, description, is_synthetic, polly_voice_id)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::bool[], $6::text[])`,
    [
      characters.map((c) => c.id),
      characters.map((c) => c.play_id),
      characters.map((c) => c.name),
      characters.map((c) => c.description),
      characters.map((c) => c.is_synthetic),
      characters.map((c) => c.polly_voice_id),
    ]
  );
}

const LINE_COLUMNS = [
  "id",
  "play_id",
  "act",
  "act_order",
  "scene",
  "scene_order",
  "scene_description",
  "speech_number",
  "line_number",
  "block_id",
  "beat_number",
  "text",
  "source_lines",
  "shares_first_source_line",
  "is_verse",
  "stage_direction",
] as const;

/**
 * Multi-row VALUES rather than the `SELECT * FROM unnest(...)` the other
 * inserts use, because of `source_lines`.
 *
 * unnest needs one array per column, so an array-valued column would need an
 * array *of* arrays — and CockroachDB doesn't implement multi-dimensional
 * arrays (crdb#32552), so `$n::text[][]` is a parse error, not a runtime one.
 * Passing each row's `string[]` as its own parameter sidesteps it entirely and
 * lets the driver encode the array, rather than us hand-building Postgres array
 * literals and owning the quote-escaping.
 *
 * 500-row chunks keep this at 8,000 parameters per statement, well inside the
 * 65,535 wire-protocol limit.
 */
async function insertLines(client: PoolClient, lines: BuiltPlay["lines"]): Promise<void> {
  const width = LINE_COLUMNS.length;
  for (const chunk of chunks(lines, CHUNK_SIZE)) {
    const rows = chunk
      .map((_, i) => `(${LINE_COLUMNS.map((_, c) => `$${i * width + c + 1}`).join(", ")})`)
      .join(", ");
    const params = chunk.flatMap((l) => LINE_COLUMNS.map((column) => l[column]));

    await client.query(
      `INSERT INTO lines (${LINE_COLUMNS.join(", ")}) VALUES ${rows}`,
      params
    );
  }
}

async function insertLineSpeakers(client: PoolClient, lineSpeakers: BuiltPlay["lineSpeakers"]): Promise<void> {
  for (const chunk of chunks(lineSpeakers, CHUNK_SIZE)) {
    await client.query(
      `INSERT INTO line_speakers (line_id, character_id)
       SELECT * FROM unnest($1::uuid[], $2::uuid[])`,
      [chunk.map((s) => s.line_id), chunk.map((s) => s.character_id)]
    );
  }
}

async function insertStageDirections(
  client: PoolClient,
  stageDirections: BuiltPlay["stageDirections"]
): Promise<void> {
  for (const chunk of chunks(stageDirections, CHUNK_SIZE)) {
    await client.query(
      `INSERT INTO stage_directions
         (id, play_id, act, act_order, scene, scene_order, sequence, after_line_number, text)
       SELECT * FROM unnest(
         $1::uuid[], $2::uuid[], $3::text[], $4::int[], $5::text[], $6::int[],
         $7::int[], $8::int[], $9::text[]
       )`,
      [
        chunk.map((s) => s.id),
        chunk.map((s) => s.play_id),
        chunk.map((s) => s.act),
        chunk.map((s) => s.act_order),
        chunk.map((s) => s.scene),
        chunk.map((s) => s.scene_order),
        chunk.map((s) => s.sequence),
        chunk.map((s) => s.after_line_number),
        chunk.map((s) => s.text),
      ]
    );
  }
}

export async function ingestPlay(built: BuiltPlay): Promise<void> {
  const pool = getPool();
  await withRetry(async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await assertNotAlreadyImported(client, built.play.title);
      await insertPlay(client, built.play);
      await insertCharacters(client, built.characters);
      await insertLines(client, built.lines);
      await insertLineSpeakers(client, built.lineSpeakers);
      await insertStageDirections(client, built.stageDirections);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  console.log(
    `ingested play "${built.play.title}": ${built.characters.length} characters, ` +
      `${built.lines.length} beats, ${built.lineSpeakers.length} line-speaker links, ` +
      `${built.stageDirections.length} stage directions`
  );
}
