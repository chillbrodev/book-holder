import { DbClient } from "../../clients/cockroach-db/dbClient.ts";
import { ConfigClient } from "../../clients/config-client/configClient.ts";
import { PollyClient } from "../../clients/polly-client/pollyClient.ts";
import { S3Client } from "../../clients/s3-client/s3Client.ts";
import { PollyError } from "./errors.ts";

export type LineAudio = {
  audioUrl: string;
  cached: boolean;
};

export type CacheResult = {
  cached: boolean;
};

/** Lowercase, hyphen-separated, alnum only — S3 keys allow almost anything,
 * but slugifying keeps the bucket console-browsable and avoids surprises
 * from spaces/punctuation in a title or character name. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** {play}/{character}/{lineId}__{voiceId}.mp3 — grouped for browsability in
 * the S3 console (was a flat {lineId}/{voiceId}.mp3, which is unreadable at
 * a glance). voiceId stays in the filename, not just implied by character,
 * so changing a character's voice doesn't silently serve stale audio under
 * the same path. */
function cacheKey(
  playTitle: string,
  characterName: string,
  lineId: string,
  voiceId: string,
): string {
  return `${slugify(playTitle)}/${
    slugify(characterName)
  }/${lineId}__${voiceId}.mp3`;
}

async function synthesizeAndCache(
  key: string,
  lineId: string,
  text: string,
  voiceId: string,
): Promise<void> {
  let audio: Uint8Array;
  try {
    audio = await PollyClient.synthesizeSpeech(text, voiceId);
  } catch (err) {
    // No cached audio and Polly errored/timed out — surface the line text
    // so the caller can fall back to a text-only prompt instead of
    // blocking the rehearsal (BE_PLAN.md §5).
    throw new PollyError(
      "VOICE_UNAVAILABLE",
      "Polly is unavailable and no cached audio exists for this line.",
      { cause: err, context: { lineId, text } },
    );
  }

  await S3Client.putObject(
    ConfigClient.Polly.cacheBucket,
    key,
    audio,
    "audio/mpeg",
  );
}

export const PollyService = {
  /** Synthesize-once-per-(line, voice): serves cached audio from S3 if
   * present, otherwise calls Polly and caches the result before returning.
   * See docs/BE_PLAN.md §4 (cost control) and §5 (graceful degradation).
   *
   * Voice comes from characters.polly_voice_id, not an env var — a play's
   * characters are already play-scoped in the schema, so this lets two
   * plays' same-named characters carry different voices, and lets a voice
   * be changed with an UPDATE instead of an env edit + redeploy. */
  async getLineAudio(
    input: { lineId?: string; characterId?: string },
  ): Promise<LineAudio> {
    const { lineId, characterId } = input;
    if (!lineId?.trim() || !characterId?.trim()) {
      throw new PollyError(
        "VALIDATION_ERROR",
        "lineId and characterId are both required.",
      );
    }

    // Joins through line_speakers rather than trusting characterId blindly —
    // a line can have more than one speaker (docs/BE_PLAN.md §1a), so this
    // also confirms the requested character actually speaks this line.
    const result = await DbClient.getPool().query(
      `SELECT l.text, c.name AS character_name, c.polly_voice_id, p.title AS play_title
       FROM lines l
       JOIN line_speakers ls ON ls.line_id = l.id AND ls.character_id = $2
       JOIN characters c ON c.id = ls.character_id
       JOIN plays p ON p.id = l.play_id
       WHERE l.id = $1`,
      [lineId, characterId],
    );
    if (result.rows.length === 0) {
      throw new PollyError(
        "LINE_NOT_FOUND",
        `No line ${lineId} spoken by character ${characterId}.`,
      );
    }

    const { text, character_name, polly_voice_id, play_title } = result.rows[0];
    const voiceId: string = polly_voice_id || ConfigClient.Polly.defaultVoiceId;
    const bucket = ConfigClient.Polly.cacheBucket;
    const key = cacheKey(play_title, character_name, lineId, voiceId);

    if (await S3Client.objectExists(bucket, key)) {
      return {
        audioUrl: await S3Client.getSignedGetUrl(bucket, key),
        cached: true,
      };
    }

    await synthesizeAndCache(key, lineId, text, voiceId);
    return {
      audioUrl: await S3Client.getSignedGetUrl(bucket, key),
      cached: false,
    };
  },

  /** Used by scripts/warmPollyCache.ts to pre-populate the cache ahead of a
   * user's first session, so on-demand playback never pays synthesis
   * latency. Caller already has line text (bulk-fetched), so this skips the
   * per-line DB round trip getLineAudio does. */
  async warmLine(
    input: {
      lineId: string;
      text: string;
      voiceId: string;
      playTitle: string;
      characterName: string;
    },
  ): Promise<CacheResult> {
    const { lineId, text, voiceId, playTitle, characterName } = input;
    const bucket = ConfigClient.Polly.cacheBucket;
    const key = cacheKey(playTitle, characterName, lineId, voiceId);

    if (await S3Client.objectExists(bucket, key)) {
      return { cached: true };
    }

    await synthesizeAndCache(key, lineId, text, voiceId);
    return { cached: false };
  },
};
