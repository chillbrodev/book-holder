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
    `INSERT INTO characters (id, play_id, name, description, is_synthetic)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::bool[])`,
    [
      characters.map((c) => c.id),
      characters.map((c) => c.play_id),
      characters.map((c) => c.name),
      characters.map((c) => c.description),
      characters.map((c) => c.is_synthetic),
    ]
  );
}

async function insertLines(client: PoolClient, lines: BuiltPlay["lines"]): Promise<void> {
  for (const chunk of chunks(lines, CHUNK_SIZE)) {
    await client.query(
      `INSERT INTO lines
         (id, play_id, act, act_order, scene, scene_order, scene_description,
          speech_number, line_number, text, stage_direction)
       SELECT * FROM unnest(
         $1::uuid[], $2::uuid[], $3::text[], $4::int[], $5::text[], $6::int[],
         $7::text[], $8::int[], $9::int[], $10::text[], $11::text[]
       )`,
      [
        chunk.map((l) => l.id),
        chunk.map((l) => l.play_id),
        chunk.map((l) => l.act),
        chunk.map((l) => l.act_order),
        chunk.map((l) => l.scene),
        chunk.map((l) => l.scene_order),
        chunk.map((l) => l.scene_description),
        chunk.map((l) => l.speech_number),
        chunk.map((l) => l.line_number),
        chunk.map((l) => l.text),
        chunk.map((l) => l.stage_direction),
      ]
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
      `${built.lines.length} lines, ${built.lineSpeakers.length} line-speaker links, ` +
      `${built.stageDirections.length} stage directions`
  );
}
