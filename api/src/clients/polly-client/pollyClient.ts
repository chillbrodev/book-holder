import {
  PollyClient as AwsPollyClient,
  SynthesizeSpeechCommand,
  type VoiceId,
} from "@aws-sdk/client-polly";
import { ConfigClient } from "../config-client/configClient.ts";

let client: AwsPollyClient | undefined;

function getClient(): AwsPollyClient {
  if (!client) {
    client = new AwsPollyClient({ region: ConfigClient.Aws.region });
  }
  return client;
}

export const PollyClient = {
  /** Lazy singleton — no credentials passed explicitly, see ConfigClient.Aws. */
  async synthesizeSpeech(text: string, voiceId: string): Promise<Uint8Array> {
    const result = await getClient().send(
      new SynthesizeSpeechCommand({
        Text: text,
        // characters.polly_voice_id/POLLY_DEFAULT_VOICE_ID are plain strings
        // from the DB/env, not the SDK's closed VoiceId union — an invalid
        // voice ID surfaces as a Polly API error, which the caller
        // (PollyService) already treats as VOICE_UNAVAILABLE.
        VoiceId: voiceId as VoiceId,
        // Generative, not neural — most human-like/expressive engine Polly
        // offers; only available for a subset of voices/regions (confirmed
        // us-west-2, our default, is supported) — see
        // docs.aws.amazon.com/polly/latest/dg/generative-voices.html.
        Engine: "generative",
        OutputFormat: "mp3",
      }),
    );

    if (!result.AudioStream) {
      throw new Error("Polly returned no audio stream.");
    }

    return await result.AudioStream.transformToByteArray();
  },
};
