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

/** {play}/{character}/{blockId}__{voiceId}.mp3 — grouped for browsability in
 * the S3 console (was a flat {lineId}/{voiceId}.mp3, which is unreadable at
 * a glance). voiceId stays in the filename, not just implied by character,
 * so changing a character's voice doesn't silently serve stale audio under
 * the same path.
 *
 * Keyed on the *block*, not the beat: a speech is synthesized once, whole.
 * Rendering it beat by beat gives each fragment sentence-final intonation and
 * a trailing pause, which is audible as stop-start delivery and is baked into
 * the bytes — see docs/beats-and-blocks-plan.md §1. */
function cacheKey(
  playTitle: string,
  characterName: string,
  blockId: string,
  voiceId: string,
): string {
  return `${slugify(playTitle)}/${
    slugify(characterName)
  }/${blockId}__${voiceId}.mp3`;
}

async function synthesizeAndCache(
  key: string,
  blockId: string,
  text: string,
  voiceId: string,
): Promise<void> {
  let audio: Uint8Array;
  try {
    audio = await PollyClient.synthesizeSpeech(text, voiceId);
  } catch (err) {
    // No cached audio and Polly errored/timed out — surface the block text
    // so the caller can fall back to a text-only prompt instead of
    // blocking the rehearsal (BE_PLAN.md §5).
    throw new PollyError(
      "VOICE_UNAVAILABLE",
      "Polly is unavailable and no cached audio exists for this block.",
      { cause: err, context: { blockId, text } },
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
  async getBlockAudio(
    input: { blockId?: string; characterId?: string },
  ): Promise<LineAudio> {
    const { blockId, characterId } = input;
    if (!blockId?.trim() || !characterId?.trim()) {
      throw new PollyError(
        "VALIDATION_ERROR",
        "blockId and characterId are both required.",
      );
    }

    // The block's beats concatenated in order, server-side. The client sends
    // only a block id — it can't send an ordered list of beats, because only
    // the importer knew where a stage direction split the speech, and that
    // grouping is persisted as block_id rather than re-derived here.
    //
    // Joins through line_speakers rather than trusting characterId blindly —
    // a line can have more than one speaker (docs/BE_PLAN.md §1a), so this
    // also confirms the requested character actually speaks this block.
    const result = await DbClient.getPool().query(
      `SELECT string_agg(l.text, ' ' ORDER BY l.beat_number) AS text,
              max(c.name) AS character_name,
              max(c.polly_voice_id) AS polly_voice_id,
              max(p.title) AS play_title
       FROM lines l
       JOIN line_speakers ls ON ls.line_id = l.id AND ls.character_id = $2
       JOIN characters c ON c.id = ls.character_id
       JOIN plays p ON p.id = l.play_id
       WHERE l.block_id = $1`,
      [blockId, characterId],
    );
    if (result.rows.length === 0 || !result.rows[0].text) {
      throw new PollyError(
        "LINE_NOT_FOUND",
        `No block ${blockId} spoken by character ${characterId}.`,
      );
    }

    const { text, character_name, polly_voice_id, play_title } = result.rows[0];
    const voiceId: string = polly_voice_id || ConfigClient.Polly.defaultVoiceId;
    const bucket = ConfigClient.Polly.cacheBucket;
    const key = cacheKey(play_title, character_name, blockId, voiceId);

    if (await S3Client.objectExists(bucket, key)) {
      return {
        audioUrl: await S3Client.getSignedGetUrl(bucket, key),
        cached: true,
      };
    }

    await synthesizeAndCache(key, blockId, text, voiceId);
    return {
      audioUrl: await S3Client.getSignedGetUrl(bucket, key),
      cached: false,
    };
  },

  /** Used by scripts/warmPollyCache.ts to pre-populate the cache ahead of a
   * user's first session, so on-demand playback never pays synthesis
   * latency. Caller already has the block text (bulk-fetched), so this skips
   * the per-block DB round trip getBlockAudio does.
   *
   * Must key identically to getBlockAudio — a warm run keyed even slightly
   * differently pays for a full synthesis pass and then misses on every real
   * request. */
  async warmBlock(
    input: {
      blockId: string;
      text: string;
      voiceId: string;
      playTitle: string;
      characterName: string;
    },
  ): Promise<CacheResult> {
    const { blockId, text, voiceId, playTitle, characterName } = input;
    const bucket = ConfigClient.Polly.cacheBucket;
    const key = cacheKey(playTitle, characterName, blockId, voiceId);

    if (await S3Client.objectExists(bucket, key)) {
      return { cached: true };
    }

    await synthesizeAndCache(key, blockId, text, voiceId);
    return { cached: false };
  },
};
