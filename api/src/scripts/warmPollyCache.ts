// Pre-synthesizes and caches Polly audio for speech *blocks*, grouped by
// character
// (one Polly voice per character, see characters.polly_voice_id —
// infra/cockroachdb/migrations/003_polly_voice_id.sql) so a user's first
// real rehearsal session never pays the on-demand synthesize-and-cache
// latency described in docs/BE_PLAN.md §4. Safe to re-run — already-cached
// (block, voice) pairs are skipped via the same S3 HeadObject check the live
// /polly/blocks/:blockId/audio endpoint uses.
//
// A block, not a beat: one speech is one render. Warming per beat would both
// cost more calls and cache audio nothing ever requests, since playback asks
// for blocks — and it must key identically to getBlockAudio or the whole pass
// is wasted (docs/beats-and-blocks-plan.md §6).
//
// Defaults to a dry run (prints scope + an estimated Polly cost, calls
// nothing) since this can trigger hundreds of billed Polly calls — pass
// --yes to actually synthesize.
//
// Usage:
//   deno task warm-polly-cache -- --play "Merry Wives of Windsor"
//   deno task warm-polly-cache -- --play "Merry Wives of Windsor" --yes
//   deno task warm-polly-cache -- --character FALSTAFF --yes
//   deno task warm-polly-cache -- --yes --concurrency 3   # whole corpus, all plays

import { DbClient } from "../clients/cockroach-db/dbClient.ts";
import { ConfigClient } from "../clients/config-client/configClient.ts";
import { PollyService } from "../features/polly/service.ts";

// Neural engine (pollyClient.ts) — $16/1M chars, with a 1M-char/mo free tier.
// Was generative at $30/1M and a 100K-char tier; see POLLY_ENGINE for why that
// changed. Keep this in step with the engine, or the dry run's estimate is
// wrong in whichever direction costs the most to discover.
// See aws.amazon.com/polly/pricing.
const NEURAL_RATE_USD_PER_MILLION_CHARS = 16;

type BlockRow = {
  blockId: string;
  text: string;
  characterName: string;
  playTitle: string;
  voiceId: string;
};

type CliArgs = {
  play?: string;
  character?: string;
  concurrency: number;
  yes: boolean;
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
    character: typeof raw.character === "string" ? raw.character : undefined,
    concurrency: typeof raw.concurrency === "string"
      ? Number.parseInt(raw.concurrency, 10)
      : 4,
    yes: raw.yes === true,
  };
}

async function fetchBlocks(
  play: string | undefined,
  character: string | undefined,
): Promise<BlockRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (play) {
    params.push(play);
    conditions.push(`p.title = $${params.length}`);
  }
  if (character) {
    params.push(character.toUpperCase());
    conditions.push(`upper(c.name) = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await DbClient.getPool().query(
    `SELECT l.block_id,
            string_agg(l.text, ' ' ORDER BY l.beat_number) AS text,
            c.name AS character_name, c.polly_voice_id, p.title AS play_title,
            min(l.act_order) AS act_order, min(l.scene_order) AS scene_order,
            min(l.line_number) AS line_number
     FROM lines l
     JOIN line_speakers ls ON ls.line_id = l.id
     JOIN characters c ON c.id = ls.character_id
     JOIN plays p ON p.id = l.play_id
     ${where}
     GROUP BY l.block_id, c.name, c.polly_voice_id, p.title
     ORDER BY c.name, act_order, scene_order, line_number`,
    params,
  );
  return result.rows.map((
    r: {
      block_id: string;
      text: string;
      character_name: string;
      polly_voice_id: string | null;
      play_title: string;
    },
  ) => ({
    blockId: r.block_id,
    text: r.text,
    characterName: r.character_name,
    playTitle: r.play_title,
    voiceId: r.polly_voice_id || ConfigClient.Polly.defaultVoiceId,
  }));
}

function groupByCharacter(lines: BlockRow[]): Map<string, BlockRow[]> {
  const groups = new Map<string, BlockRow[]>();
  for (const line of lines) {
    const group = groups.get(line.characterName);
    if (group) {
      group.push(line);
    } else {
      groups.set(line.characterName, [line]);
    }
  }
  return groups;
}

/** Runs `worker` over `items` with at most `limit` in flight — a hand-rolled
 * pool rather than a dependency, since this is the only place in the repo
 * that needs one. Keeps concurrent Polly calls bounded so a large warm run
 * doesn't hammer into the account's SynthesizeSpeech rate limit (the SDK's
 * default retry/backoff absorbs occasional throttling, this just keeps it
 * occasional). */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function next(): Promise<void> {
    const i = cursor++;
    if (i >= items.length) return;
    await worker(items[i]);
    return next();
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => next()),
  );
}

if (import.meta.main) {
  const args = parseArgs(Deno.args);
  const lines = await fetchBlocks(args.play, args.character);

  if (lines.length === 0) {
    console.log("No matching lines found — check --play/--character.");
    Deno.exit(1);
  }

  const groups = groupByCharacter(lines);
  const totalChars = lines.reduce((sum, l) => sum + l.text.length, 0);
  const estimatedCostUsd = (totalChars / 1_000_000) *
    NEURAL_RATE_USD_PER_MILLION_CHARS;

  console.log(
    `${groups.size} character(s), ${lines.length} line(s), ~${totalChars} characters of text.`,
  );
  console.log(
    `Estimated Polly cost if none of this is cached yet: ~$${
      estimatedCostUsd.toFixed(2)
    } ` +
      `(neural, $${NEURAL_RATE_USD_PER_MILLION_CHARS}/1M chars, against a ` +
      `1M-char/mo free tier; already-cached lines cost nothing to re-run against).`,
  );

  if (!args.yes) {
    console.log(
      "\nDry run — pass --yes to actually call Polly and populate the cache.",
    );
    Deno.exit(0);
  }

  let cachedCount = 0;
  let synthesizedCount = 0;
  let failedCount = 0;

  for (const [characterName, characterLines] of groups) {
    // Every line in a group shares one voice — it's a property of the
    // character (characters.polly_voice_id), not the line.
    console.log(
      `\n${characterName} -> voice ${
        characterLines[0].voiceId
      } (${characterLines.length} blocks)`,
    );

    await runWithConcurrency(characterLines, args.concurrency, async (line) => {
      try {
        const { cached } = await PollyService.warmBlock({
          blockId: line.blockId,
          text: line.text,
          voiceId: line.voiceId,
          playTitle: line.playTitle,
          characterName: line.characterName,
        });
        if (cached) cachedCount++;
        else synthesizedCount++;
      } catch (err) {
        failedCount++;
        console.error(
          `  FAILED block ${line.blockId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
  }

  console.log(
    `\nDone — ${synthesizedCount} synthesized, ${cachedCount} already cached, ${failedCount} failed.`,
  );
  if (failedCount > 0) Deno.exit(1);
}
