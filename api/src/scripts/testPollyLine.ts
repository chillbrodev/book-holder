// Quick single-block smoke test for the Polly cache path (S3 HeadObject ->
// Polly synth -> S3 PutObject): no database involved, so it isolates
// credentials/API issues from DB/import concerns. Uses a synthetic blockId
// ("test-block") rather than a real one, so re-running doesn't touch/collide
// with cached audio for actual script blocks.
//
// Use warmPollyCache.ts for the real batch run once this succeeds.
//
// Usage:
//   deno task test-polly-line
//   deno task test-polly-line -- --voice Amy --text "Custom line to try."

import { PollyService } from "../features/polly/service.ts";

function parseArgs(
  argv: string[],
): { text: string; voice: string; play: string; character: string } {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg.startsWith("--") && next !== undefined) {
      raw[arg.slice(2)] = next;
      i++;
    }
  }
  return {
    text: raw.text ?? "Why, then the world's mine oyster.",
    voice: raw.voice ?? "Brian",
    // Deliberately not a real play/character, keeps this smoke test's
    // cache object under a clearly-scratch path (test/test/...) rather than
    // mixed in among real cached blocks.
    play: raw.play ?? "test",
    character: raw.character ?? "test",
  };
}

if (import.meta.main) {
  const { text, voice, play, character } = parseArgs(Deno.args);
  console.log(`Synthesizing via voice "${voice}": "${text}"`);

  try {
    const { cached } = await PollyService.warmBlock({
      blockId: "test-block",
      text,
      voiceId: voice,
      playTitle: play,
      characterName: character,
    });
    console.log(
      cached
        ? "Already cached — hit, no Polly call made."
        : "Synthesized and cached — success.",
    );
  } catch (err) {
    console.error("FAILED:", err instanceof Error ? err.message : String(err));

    // PollyError wraps the real AWS SDK error as `cause` (see
    // features/polly/service.ts) but nothing normally prints it, surface it
    // here since that's the actual diagnostic signal.
    const cause = (err as { cause?: unknown } | undefined)?.cause;
    if (cause instanceof Error) {
      console.error("Underlying cause:", cause.name, "-", cause.message);
      const metadata = (cause as { $metadata?: unknown }).$metadata;
      if (metadata) {
        console.error("  $metadata:", JSON.stringify(metadata, null, 2));
      }
    } else if (cause) {
      console.error("Underlying cause:", cause);
    }
    Deno.exit(1);
  }
}
