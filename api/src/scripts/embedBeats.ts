// Fills `lines.embedding` for every beat of a play, so the coach can ask
// "what else is like this?" instead of only "what did she say here?".
//
// Deliberately not part of the importer. `docs/OPEN_ITEMS.md` §2: the importer
// must stay offline, deterministic, and re-runnable with no AWS credentials,
// which is what makes its `--dry-run` review worth reading. The same reasoning
// keeps Polly warming out of it. This is the third member of that family and
// follows warmPollyCache's shape on purpose, dry run by default, `--yes` to
// spend money, resumable, and keyed so a second pass skips what the first did.
//
// Idempotent by construction: it only selects rows `WHERE embedding IS NULL`,
// so re-running after a partial pass costs nothing for what already landed.
// Re-importing changed text produces new line ids (content-derived, see
// packages/play-importer/src/ids.ts), which arrive with a NULL embedding and
// are picked up by the next run. Unchanged text keeps its id and its vector.
//
// Usage:
//   deno task embed-beats                                   # dry run, whole corpus
//   deno task embed-beats -- --play "Merry Wives of Windsor"
//   deno task embed-beats -- --yes
//   deno task embed-beats -- --yes --concurrency 4

import { DbClient } from "../clients/cockroach-db/dbClient.ts";
import {
  EMBEDDING_DIMENSION,
  EmbeddingsClient,
} from "../clients/bedrock-client/embeddingsClient.ts";

// Titan Text Embeddings V2 is $0.02 per million input tokens. The whole of
// Merry Wives is ~27,000 tokens (`OPEN_ITEMS.md` §2), so a full pass is a
// fraction of a cent, but the estimate is printed anyway, because the reason
// warmPollyCache defaults to a dry run is that nobody should have to guess what
// a script is about to spend.
const TITAN_V2_USD_PER_MILLION_TOKENS = 0.02;

// Rough, and only used for the estimate. Shakespeare runs a little under the
// usual 4-chars-per-token because of the short words and heavy punctuation.
const CHARS_PER_TOKEN = 3.6;

/**
 * Concurrency default.
 *
 * Lower than it could be, for the reason recorded in CLAUDE.md about Polly:
 * a first warming pass at concurrency 6 lost 254 of 1064 blocks to throttling.
 * Bedrock's limits are not Polly's, but the lesson; that a bulk pass is the
 * one place throttling actually bites, is the same, and `retryMode: adaptive`
 * on the client is the other half of it.
 */
const DEFAULT_CONCURRENCY = 4;

type BeatRow = {
  id: string;
  text: string;
  playTitle: string;
};

type CliArgs = {
  play?: string;
  concurrency: number;
  yes: boolean;
  /** Stop after this many beats. For proving the model id, the dimension and
   * the `::VECTOR` cast all work before committing to a full pass, a wrong
   * model id otherwise fails 1,705 times with a retry ladder behind each. */
  limit?: number;
};

function parseArgs(argv: string[]): CliArgs {
  const raw: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      raw[key] = next;
      i++;
    } else {
      raw[key] = true;
    }
  }
  return {
    play: typeof raw.play === "string" ? raw.play : undefined,
    concurrency: typeof raw.concurrency === "string"
      ? Number.parseInt(raw.concurrency, 10)
      : DEFAULT_CONCURRENCY,
    yes: raw.yes === true,
    limit: typeof raw.limit === "string"
      ? Number.parseInt(raw.limit, 10)
      : undefined,
  };
}

async function findUnembeddedBeats(play?: string): Promise<BeatRow[]> {
  // `l.text` rather than the block's concatenated text: the beat is the unit
  // everywhere else in this codebase, and a vector over a whole speech would
  // answer a different question than the one the coach asks.
  const result = await DbClient.getPool().query(
    `SELECT l.id, l.text, p.title AS play_title
       FROM lines l
       JOIN plays p ON p.id = l.play_id
      WHERE l.embedding IS NULL
        AND length(trim(l.text)) > 0
        ${play ? "AND p.title ILIKE $1" : ""}
      ORDER BY l.play_id, l.line_number`,
    play ? [`%${play}%`] : [],
  );

  return result.rows.map((
    row: { id: string; text: string; play_title: string },
  ) => ({
    id: row.id,
    text: row.text,
    playTitle: row.play_title,
  }));
}

async function embedOne(beat: BeatRow): Promise<void> {
  const embedding = await EmbeddingsClient.embed(beat.text);
  await DbClient.getPool().query(
    // $2::VECTOR, not a bare parameter: a JS array binds as a Postgres array
    // and is rejected outright. The literal-plus-cast is what CockroachDB takes.
    `UPDATE lines SET embedding = $2::VECTOR WHERE id = $1`,
    [beat.id, EmbeddingsClient.toVectorLiteral(embedding)],
  );
}

/** Bounded worker pool. Same shape as warmPollyCache's, and bounded for the
 * same reason, an unbounded Promise.all over 1,705 beats is a throttling
 * incident, not a fast script. */
async function runPool<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
  onDone: (index: number, error?: unknown) => void,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try {
        await work(items[index]);
        onDone(index);
      } catch (err) {
        onDone(index, err);
      }
    }
  });
  await Promise.all(workers);
}

if (import.meta.main) {
  const args = parseArgs(Deno.args);
  const allBeats = await findUnembeddedBeats(args.play);
  const beats = args.limit !== undefined
    ? allBeats.slice(0, args.limit)
    : allBeats;

  const totalChars = beats.reduce((sum, beat) => sum + beat.text.length, 0);
  const estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
  const estimatedUsd = (estimatedTokens / 1_000_000) *
    TITAN_V2_USD_PER_MILLION_TOKENS;

  console.log(`beats needing an embedding: ${beats.length}`);
  if (args.limit !== undefined) {
    console.log(`  (--limit ${args.limit} of ${allBeats.length} outstanding)`);
  }
  console.log(`  ${args.play ? `play filter: ${args.play}` : "all plays"}`);
  console.log(`  dimension:   ${EMBEDDING_DIMENSION}`);
  console.log(`  ~chars:      ${totalChars.toLocaleString()}`);
  console.log(`  ~tokens:     ${estimatedTokens.toLocaleString()}`);
  console.log(`  ~cost:       $${estimatedUsd.toFixed(4)}`);

  if (beats.length === 0) {
    console.log("\nNothing to do.");
    Deno.exit(0);
  }

  if (!args.yes) {
    console.log(
      `\nDry run — nothing called, nothing written. Re-run with --yes to embed.`,
    );
    Deno.exit(0);
  }

  console.log(`\nEmbedding at concurrency ${args.concurrency}...`);
  const startedAt = Date.now();
  let done = 0;
  let failed = 0;

  await runPool(beats, args.concurrency, embedOne, (_index, error) => {
    done++;
    if (error) {
      failed++;
      console.error(
        `  failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (done % 100 === 0 || done === beats.length) {
      console.log(`  ${done}/${beats.length} (${failed} failed)`);
    }
  });

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\nEmbedded ${done - failed}/${beats.length} in ${elapsedSeconds}s` +
      (failed > 0 ? ` — ${failed} failed, re-run to retry just those` : ""),
  );
}
