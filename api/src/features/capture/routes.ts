import { Hono } from "hono";
import { CaptureSession } from "./service.ts";
import { CaptureError } from "./errors.ts";
import { CoachingService } from "../coaching/service.ts";
import type { AppEnv } from "../../types.ts";

const capture = new Hono<AppEnv>();

/**
 * The mic, for one block.
 *
 * A WebSocket rather than a POST because capture is genuinely bidirectional and
 * continuous: PCM goes up while beat progress comes down, both for the duration
 * of one speech. `useMicSimulation`'s comment in the frontend called this out
 * before any of it existed — the real thing is a streaming integration, not a
 * REST call.
 *
 * `Deno.upgradeWebSocket` directly rather than Hono's adapter helper: the app is
 * served by `Deno.serve(app.fetch)` (src/main.ts), so a raw `Response` from
 * `Deno.upgradeWebSocket` passes straight back through Hono untouched, and this
 * keeps one fewer adapter between us and a protocol whose failures are already
 * hard to see.
 *
 * No auth gate, matching /polly and /plays: rehearsing works fully as a guest.
 * Unlike Polly, though, every connection here *does* bill — there is no cache to
 * hit, because you cannot pre-warm what she hasn't said yet. The guards are the
 * duration ceiling in AudioQueue and the fact that a stream only bills for audio
 * actually forwarded. Worth revisiting if this is ever exposed to real traffic:
 * this is the one endpoint where an anonymous client can spend money on demand.
 */
capture.get("/blocks/:blockId", (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    throw new CaptureError(
      "UPGRADE_REQUIRED",
      "This endpoint speaks WebSocket only.",
    );
  }

  const blockId = c.req.param("blockId");
  const characterId = c.req.query("characterId");

  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);

  let session: CaptureSession | undefined;
  // Audio that arrives before the DB lookup finishes. Without this the first
  // frames are silently dropped, which costs the opening words of the block —
  // the ones she is most likely to be judged on getting wrong.
  const early: Uint8Array[] = [];
  // The same race, for the control frame rather than the audio. `done` arriving
  // before `session` exists used to hit `session?.finish()` and vanish — and
  // because `done` is the only thing that closes the audio queue, the capture
  // then ran until the duration ceiling instead of finishing. Silent, and it
  // leaves a billing Transcribe stream open the whole time.
  //
  // Narrow but reachable: the window is one database round trip, and the client
  // sends `done` on a tap she can make immediately. Found by a probe that opened
  // the socket and said `done` in the same tick, which is the worst case rather
  // than an unrealistic one.
  let finishRequested = false;

  const send = (event: unknown) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event));
    }
  };

  socket.onopen = async () => {
    try {
      session = await CaptureSession.open({ blockId, characterId }, send);
      for (const chunk of early) session.pushAudio(chunk);
      early.length = 0;
      // Replayed after the audio, never before: finishing closes the queue, and
      // anything still in `early` would be dropped on the floor.
      if (finishRequested) session.finish();
      // Deliberately not awaited before returning: run() lives as long as the
      // stream does, and onopen must not block the socket's message pump.
      const result = await session.run();

      // Coaching happens here rather than inside CaptureSession, so that
      // `features/capture` stays a capture feature. The socket is simply the
      // channel the answer travels back on.
      //
      // The socket is held open across this call — about a second — even though
      // `complete` has already gone. That second is invisible to the mic UI,
      // which moved on the moment `complete` landed, and it is the difference
      // between the annotation arriving on this connection and needing a second
      // route to deliver it.
      //
      // coachBlock never throws (BE_PLAN.md §5): on any failure it answers from
      // word recall and says so in `source`. So there is no catch here, and a
      // rehearsal is never blocked on Bedrock.
      if (result) {
        const coaching = await CoachingService.coachBlock(result);
        send({ type: "scored", ...coaching });
      }

      // Transcribe has closed and both events have been sent, so there is
      // nothing further to say on this socket.
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, "complete");
    } catch (err) {
      if (err instanceof CaptureError) {
        send({ type: "error", name: err.name, msg: err.message });
        socket.close(1008, err.name);
        return;
      }
      console.error("Capture session failed to open:", err);
      send({
        type: "error",
        name: "INTERNAL_SERVER_ERROR",
        msg: "Something went wrong.",
      });
      socket.close(1011, "INTERNAL_SERVER_ERROR");
    }
  };

  socket.onmessage = (event) => {
    // Binary frames are PCM (16 kHz, mono, 16-bit signed LE — see
    // transcribeClient.ts). Text frames are control messages. Splitting on the
    // frame type rather than a header keeps audio out of JSON, which would
    // inflate it by a third for no reason.
    if (event.data instanceof ArrayBuffer) {
      const chunk = new Uint8Array(event.data);
      if (session) session.pushAudio(chunk);
      else early.push(chunk);
      return;
    }

    if (typeof event.data !== "string") return;
    try {
      const message = JSON.parse(event.data);
      // "done" is her finishing the speech, which is the normal end: it closes
      // the audio, which closes the Transcribe stream, which lets run() emit
      // `complete`. The socket stays open until that arrives.
      if (message?.type === "done") {
        if (session) session.finish();
        else finishRequested = true;
      }
    } catch {
      // A malformed control frame is not worth killing a live capture over.
      console.warn("Ignoring unparseable capture control message.");
    }
  };

  // Both paths close the audio queue rather than only the happy one: a browser
  // tab closing mid-speech is the common case, and an un-closed queue would hold
  // a billing Transcribe stream open until the duration ceiling caught it.
  socket.onclose = () => session?.finish();
  socket.onerror = (err) => {
    console.error(`Capture socket error for block ${blockId}:`, err);
    session?.finish();
  };

  return response;
});

export default capture;
