import {
  type AudioStream,
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient as AwsTranscribeStreamingClient,
} from "@aws-sdk/client-transcribe-streaming";
import { ConfigClient } from "../config-client/configClient.ts";

/**
 * Streaming, not batch — and the reasoning is in docs/capture-plan.md §6, not
 * here, because it is a product decision rather than a client detail. The short
 * version: "Line?" has to hand over the next beat while she is still mid-speech,
 * which a post-utterance transcript cannot support at any price. Both modes bill
 * identically, so this costs nothing to prefer.
 */
export const TRANSCRIBE_MEDIA_ENCODING = "pcm";

/**
 * 16 kHz mono, 16-bit signed little-endian.
 *
 * Transcribe accepts 8–48 kHz; 16 kHz is its recommendation for speech and is a
 * quarter of 48 kHz's bytes with no accuracy cost on a voice. It is also what
 * Polly emits for `OutputFormat: "pcm"`, which is what makes a Polly render
 * usable directly as a test fixture for this path (docs/capture-plan.md §2) —
 * keep the two the same so that stays true.
 */
export const TRANSCRIBE_SAMPLE_RATE = 16000;
export const TRANSCRIBE_BYTES_PER_SAMPLE = 2;

/** en-US rather than en-GB despite British voices on the Polly side: the voices
 * are the play's characters, this is the user's own accent, and the two have no
 * reason to match. Revisit per-user if the accent ever measurably hurts the
 * transcript on Shakespearean text. */
const LANGUAGE_CODE = "en-US";

export type TranscriptUpdate = {
  /** Everything transcribed in this *segment* so far. Transcribe revises the tail
   * of a partial, so this replaces the previous update for the same segment
   * rather than appending to it.
   *
   * A segment is Transcribe's own unit, decided by its pause and punctuation
   * logic, and it has no relationship to a beat: one real 8-beat speech came back
   * as 6 segments, one of which covered three beats by itself. Callers wanting
   * the whole utterance must accumulate finalized segments themselves — see
   * CaptureSession. This is deliberately left faithful to the API rather than
   * pre-joined, so the partial/final distinction stays visible. */
  transcript: string;
  /** False only once Transcribe has committed to this segment. A partial is a
   * guess that the next update may rewrite, so it may drive the cursor and the
   * UI but must never be scored (docs/capture-plan.md §7). */
  isPartial: boolean;
  /** Seconds into the stream, for lining a segment up against the audio. */
  startTime: number;
  endTime: number;
};

let client: AwsTranscribeStreamingClient | undefined;

function getClient(): AwsTranscribeStreamingClient {
  if (!client) {
    // Runs on Deno's node:http2 compatibility layer, which the SDK reaches for
    // by default (its NodeHttp2Handler) and which Deno documents as only
    // *partially* supported. Verified working on Deno 2.9.4 end to end against
    // the real service — see docs/capture-plan.md §2. Worth re-checking on a
    // Deno upgrade, because the failure mode would be a transport error on every
    // capture rather than anything a type check would notice.
    client = new AwsTranscribeStreamingClient({
      region: ConfigClient.Aws.region,
      // Unlike Polly's bulk warming, nothing here runs flat out — one stream per
      // block, driven by a human speaking in real time — so the SDK's default
      // retry behaviour is right. Adaptive rate limiting would be measuring a
      // load pattern that doesn't exist.
    });
  }
  return client;
}

export const TranscribeClient = {
  /**
   * Opens one streaming transcription and yields transcript updates until the
   * audio iterable finishes.
   *
   * The caller owns the audio: this consumes whatever `audioChunks` yields and
   * closes the stream when it ends. That inversion matters because the audio
   * source is a WebSocket being fed by a browser, and the shape of "when is she
   * done" belongs with the session that knows about blocks and beats, not with a
   * transport wrapper.
   *
   * One stream per block, which pays Transcribe's 15-second-per-request minimum
   * on 89% of blocks in the corpus. That is deliberate and measured — see
   * docs/capture-plan.md §5, which also records the 3.06×-cheaper alternative and
   * why it lost.
   */
  async *transcribe(
    audioChunks: AsyncIterable<Uint8Array>,
  ): AsyncGenerator<TranscriptUpdate> {
    async function* toAudioEvents(): AsyncGenerator<AudioStream> {
      for await (const chunk of audioChunks) {
        yield { AudioEvent: { AudioChunk: chunk } };
      }
    }

    const response = await getClient().send(
      new StartStreamTranscriptionCommand({
        LanguageCode: LANGUAGE_CODE,
        MediaEncoding: TRANSCRIBE_MEDIA_ENCODING,
        MediaSampleRateHertz: TRANSCRIBE_SAMPLE_RATE,
        AudioStream: toAudioEvents(),
        // Stabilization trades a little latency for a tail that stops being
        // rewritten. Without it the cursor jitters on every partial; with it,
        // words arrive already committed and the beat cursor moves once.
        EnablePartialResultsStabilization: true,
        PartialResultsStability: "high",
      }),
    );

    if (!response.TranscriptResultStream) {
      throw new Error("Transcribe opened a stream with no result stream.");
    }

    for await (const event of response.TranscriptResultStream) {
      for (const result of event.TranscriptEvent?.Transcript?.Results ?? []) {
        const transcript = result.Alternatives?.[0]?.Transcript;
        if (transcript === undefined) continue;
        yield {
          transcript,
          isPartial: result.IsPartial ?? true,
          startTime: result.StartTime ?? 0,
          endTime: result.EndTime ?? 0,
        };
      }
    }
  },
};
