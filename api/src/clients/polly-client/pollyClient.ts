import {
  PollyClient as AwsPollyClient,
  SynthesizeSpeechCommand,
  type VoiceId,
} from "@aws-sdk/client-polly";
import { ConfigClient } from "../config-client/configClient.ts";

/**
 * Neural, not generative.
 *
 * Generative is the more expressive engine, and was used here first for that
 * reason. It is also LLM-based and non-deterministic: the same string renders
 * differently on every call, and occasionally it does not stop at the end of
 * the text. Three blocks in the Merry Wives cache came back with invented
 * sentences spoken after the real line, Evans's "The dozen white louses..."
 * rendered as 21.2s of audio against a ~9s baseline, with a fabricated line
 * about Saint George on the end.
 *
 * Neural returns byte-identical audio for identical input (verified: three
 * runs of the same line, same md5), so a render cannot drift into invention.
 * It is also cheaper, $16 vs $30 per 1M characters, with a 1M-character
 * monthly free tier against generative's 100K.
 *
 * This is part of the S3 cache key (features/polly/service.ts). Changing it
 * re-renders every block rather than serving the previous engine's audio from
 * the same path, which is exactly the trap that kept the bad renders alive:
 * the key had no engine in it, so switching engines alone would have changed
 * nothing that was already cached.
 */
export const POLLY_ENGINE = "neural";

let client: AwsPollyClient | undefined;

function getClient(): AwsPollyClient {
  if (!client) {
    client = new AwsPollyClient({
      region: ConfigClient.Aws.region,
      // The neural engine's SynthesizeSpeech quota is far lower than
      // generative's, and a cache-warming pass is the one workload that runs
      // flat out against it: the first neural warm of Merry Wives lost 254 of
      // 1064 blocks to ThrottlingException under the SDK's defaults.
      //
      // "adaptive" adds a client-side rate limiter that measures the throttling
      // it receives and paces subsequent calls, rather than "standard"'s
      // fixed exponential backoff which retries into the same wall. Paired
      // with a higher attempt ceiling, since being throttled is the expected
      // state during a warm run, not an error, a block that needs six tries
      // to land still costs one synthesis.
      retryMode: "adaptive",
      maxAttempts: 8,
    });
  }
  return client;
}

export const PollyClient = {
  /** Lazy singleton: no credentials passed explicitly, see ConfigClient.Aws. */
  async synthesizeSpeech(text: string, voiceId: string): Promise<Uint8Array> {
    const result = await getClient().send(
      new SynthesizeSpeechCommand({
        Text: text,
        // characters.polly_voice_id/POLLY_DEFAULT_VOICE_ID are plain strings
        // from the DB/env, not the SDK's closed VoiceId union, an invalid
        // voice ID surfaces as a Polly API error, which the caller
        // (PollyService) already treats as VOICE_UNAVAILABLE.
        VoiceId: voiceId as VoiceId,
        Engine: POLLY_ENGINE,
        OutputFormat: "mp3",
      }),
    );

    if (!result.AudioStream) {
      throw new Error("Polly returned no audio stream.");
    }

    return await result.AudioStream.transformToByteArray();
  },
};
