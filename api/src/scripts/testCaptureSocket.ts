// Drives the capture socket end to end with no microphone, to prove that a
// finished block now comes back scored.
//
// What it exercises that a unit test cannot: the real WebSocket route, a real
// Transcribe stream, and a real Bedrock call, in the order and on the connection
// the browser uses. What it deliberately does NOT exercise is speech — it opens
// the socket and immediately says "done", so no audio is ever forwarded.
//
// That is the useful case rather than a degenerate one. A block where she said
// nothing is a real outcome (she skipped it, or the mic never picked her up),
// and the expected result is a complete event with every `heard` empty followed
// by a scored event with every beat **dry** at confidence 0 — which is also the
// one judgement the rubric is forbidden from getting wrong in her favour.
//
// Bills: one Transcribe stream (minimum 15 billed seconds, see capture-plan.md
// §5) and one Nova Micro call. Pennies, but not free.
//
// Requires the API running: `deno task dev` or `npm run dev` from the repo root.
//
// Usage:
//   deno task test-capture-socket
//   deno task test-capture-socket -- --block <uuid> --character <uuid>

const DEFAULT_BLOCK = "d1850c3c-33e5-5eb2-9862-a94cd8a791c4";
const DEFAULT_CHARACTER = "00c01cf0-b14c-4886-805d-168b3bbef76d";
const DEFAULT_ORIGIN = "ws://localhost:8000";

function arg(name: string, fallback: string): string {
  const index = Deno.args.indexOf(`--${name}`);
  return index >= 0 && Deno.args[index + 1] ? Deno.args[index + 1] : fallback;
}

if (import.meta.main) {
  const block = arg("block", DEFAULT_BLOCK);
  const character = arg("character", DEFAULT_CHARACTER);
  const origin = arg("origin", DEFAULT_ORIGIN);

  const url = `${origin}/capture/blocks/${block}?characterId=${character}`;
  console.log(`connecting: ${url}\n`);

  const socket = new WebSocket(url);
  const seen: string[] = [];
  let scored: Record<string, unknown> | undefined;
  let complete: Record<string, unknown> | undefined;

  const finished = Promise.withResolvers<void>();

  socket.onopen = () => {
    // No audio at all. Saying "done" immediately closes the queue, which closes
    // the Transcribe stream, which is what lets run() reach `complete`.
    socket.send(JSON.stringify({ type: "done" }));
  };

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data) as Record<string, unknown>;
    const type = String(message.type);
    seen.push(type);

    if (type === "ready") {
      console.log(`ready      beats=${message.beatCount}`);
    } else if (type === "progress") {
      // Expected to be absent with no audio; printed if it turns up because
      // that would mean Transcribe emitted something from silence.
      console.log(`progress   ${JSON.stringify(message.transcript)}`);
    } else if (type === "complete") {
      complete = message;
      const heard = message.heard as { heard: string }[];
      console.log(
        `complete   ${heard.length} beat(s), all empty: ${
          heard.every((beat) => beat.heard === "")
        }`,
      );
    } else if (type === "scored") {
      scored = message;
      const beats = message.beats as { band: string; confidence: number }[];
      console.log(
        `scored     source=${message.source} bands=[${
          beats.map((beat) => beat.band).join(", ")
        }]`,
      );
      console.log(`           note: ${message.note || "(none)"}`);
    } else if (type === "error") {
      console.log(`error      ${message.name}: ${message.msg}`);
    }
  };

  socket.onclose = () => finished.resolve();
  socket.onerror = () => {
    console.error("\nsocket error — is the API running on " + origin + "?");
    finished.resolve();
  };

  const timeout = setTimeout(() => {
    console.error("\ntimed out after 40s");
    try {
      socket.close();
    } catch { /* already closing */ }
    finished.resolve();
  }, 40_000);

  await finished.promise;
  clearTimeout(timeout);

  console.log(`\nevents: ${seen.join(" -> ")}`);

  const beats = (scored?.beats ?? []) as { band: string; confidence: number }[];
  const checks: [string, boolean][] = [
    ["complete arrived", complete !== undefined],
    ["scored arrived", scored !== undefined],
    [
      "scored came after complete",
      seen.indexOf("scored") > seen.indexOf("complete"),
    ],
    [
      "every beat scored",
      beats.length > 0 &&
      beats.length === ((complete?.heard ?? []) as unknown[]).length,
    ],
    [
      "silence is dry at 0",
      beats.length > 0 &&
      beats.every((beat) => beat.band === "dry" && beat.confidence === 0),
    ],
  ];

  console.log("\n--- checks ---");
  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed++;
    console.log(`  ${ok ? "OK  " : "FAIL"} ${label}`);
  }
  Deno.exit(failed === 0 ? 0 : 1);
}
