import { assertEquals, assertGreater } from "@std/assert";
import { AudioQueue } from "../audioQueue.ts";

const FRAME = new Uint8Array(3200); // 100ms at 16 kHz / 16-bit

async function drain(
  queue: AudioQueue,
  onChunk?: (chunk: Uint8Array, count: number) => void | Promise<void>,
): Promise<number> {
  let count = 0;
  for await (const chunk of queue) {
    count++;
    await onChunk?.(chunk, count);
  }
  return count;
}

Deno.test("forwards pushed audio in order and ends when closed", async () => {
  const queue = new AudioQueue({ keepaliveIdleMs: 60_000 });
  queue.push(FRAME);
  queue.push(FRAME);
  queue.close();

  assertEquals(await drain(queue), 2);
  assertEquals(queue.secondsForwarded.toFixed(1), "0.2");
  assertEquals(queue.keepalivesSent, 0);
});

Deno.test("closing while the iterator is waiting ends it rather than hanging", async () => {
  const queue = new AudioQueue({ keepaliveIdleMs: 60_000 });
  const drained = drain(queue);
  // Close only after the iterator has had a chance to start waiting on an empty
  // queue; the case that would otherwise deadlock.
  await new Promise((resolve) => setTimeout(resolve, 10));
  queue.close();
  assertEquals(await drained, 0);
});

Deno.test("sends silence when she goes quiet, so Transcribe doesn't hang up", async () => {
  // Transcribe closes a stream after 15s without audio; a rehearsal has longer
  // legitimate silences than that (docs/capture-plan.md §5.2).
  const queue = new AudioQueue({ keepaliveIdleMs: 20 });
  const chunks: number[] = [];
  const drained = drain(queue, (chunk, count) => {
    chunks.push(chunk.byteLength);
    if (count === 3) queue.close();
  });
  await drained;

  assertEquals(chunks.length, 3);
  assertGreater(queue.keepalivesSent, 0);
  // Silence is all zeroes, and every keepalive frame is the same length.
  assertEquals(new Set(chunks).size, 1);
});

Deno.test("real audio resets the keepalive rather than adding to it", async () => {
  const queue = new AudioQueue({ keepaliveIdleMs: 50 });
  const started = Date.now();
  const drained = drain(queue, (_chunk, count) => {
    if (count >= 4) queue.close();
  });
  // Four frames pushed well inside the idle window: none should trigger silence.
  for (let i = 0; i < 4; i++) {
    queue.push(FRAME);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await drained;

  assertEquals(queue.keepalivesSent, 0);
  // Sanity that the test really did stay inside the window.
  assertEquals(Date.now() - started < 50, true);
});

Deno.test("stops forwarding at the capture ceiling", async () => {
  // A tab left open with a live mic bills Transcribe by the second until someone
  // notices, the guard BE_PLAN.md §4 asks for.
  let limitReached = false;
  const queue = new AudioQueue({
    keepaliveIdleMs: 60_000,
    maxCaptureSeconds: 0.3, // 3 frames
    onLimitReached: () => {
      limitReached = true;
    },
  });
  for (let i = 0; i < 20; i++) queue.push(FRAME);

  assertEquals(await drain(queue), 3);
  assertEquals(limitReached, true);
  assertEquals(queue.closed, true);
});

Deno.test("pushing after close is ignored", async () => {
  const queue = new AudioQueue({ keepaliveIdleMs: 60_000 });
  queue.push(FRAME);
  queue.close();
  queue.push(FRAME);
  assertEquals(await drain(queue), 1);
});
