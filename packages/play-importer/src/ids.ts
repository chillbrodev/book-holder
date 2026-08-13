import { createHash } from "node:crypto";

/**
 * Content-derived ids, so re-importing an unchanged play produces the same ids
 * it did last time.
 *
 * `randomUUID()` made every import mint fresh ids, which meant a re-import
 * silently invalidated everything keyed on them: the whole Polly cache (S3 keys
 * are `{play}/{character}/{blockId}__{voice}.mp3`), and every `line_mastery` /
 * `mistake_log` row. That is not hypothetical; it is how the Merry Wives voice
 * assignments were lost.
 *
 * Deriving ids from content inverts it. Same speech in the same place -> same
 * id -> cached audio and practice history still apply. Changed speech -> new id
 * -> re-synthesized and re-learned, which is correct: serving old audio for
 * edited words would be the actual bug.
 *
 * UUIDv5 (RFC 4122 §4.3): SHA-1 over a namespace and a name, with the version
 * and variant bits forced. Any stable hash would do; v5 is used because it
 * produces a well-formed UUID, which the `UUID` columns require.
 */

/** Fixed namespace for this project, arbitrary but must never change, or
 * every id in every play changes with it. */
const NAMESPACE = "6f9619ff-8b86-d011-b42d-00c04fc964ff";

function uuidV5(name: string): string {
  const namespaceBytes = Buffer.from(NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(namespaceBytes)
    .update(Buffer.from(name, "utf8"))
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
    hex.slice(20)
  }`;
}

export interface BlockKeyParts {
  playTitle: string;
  act: string;
  scene: string;
  /** Scene-local block sequence. Present purely to break ties: two identical
   * short speeches by the same character in one scene would otherwise share an
   * id, and `WHERE block_id = $1` would then splice both blocks' beats into one
   * render. The cost is that a parse change which inserts a block re-keys the
   * later blocks in that scene, bounded, and they do need re-synthesizing if
   * the scene really changed. */
  blockIndex: number;
  /** Display names, in the order the importer resolved them. */
  speakers: string[];
  /** The block's joined text, what Polly is actually handed. */
  text: string;
}

function blockKey(parts: BlockKeyParts): string {
  return [
    parts.playTitle,
    parts.act,
    parts.scene,
    parts.blockIndex,
    parts.speakers.join("+"),
    parts.text,
  ].join("|");
}

/** Stable across re-imports as long as the speech itself is unchanged, which
 * is what keeps its cached Polly render valid. */
export function blockId(parts: BlockKeyParts): string {
  return uuidV5(blockKey(parts));
}

/**
 * Stable for an unchanged beat, and deliberately *not* stable when the beat
 * rules change: the beat text is in the key, so re-cutting a speech into
 * different thoughts yields new ids and starts their mastery fresh. That is the
 * honest behaviour; a beat she has practised 20 times is not the same beat
 * once its boundaries move.
 *
 * Note the asymmetry with `blockId`, and that it is deliberate: the block's
 * concatenated text does not change when beat boundaries move, so tuning the
 * segmentation rules never invalidates the Polly cache, only the per-beat
 * practice history it should invalidate.
 */
export function beatId(parts: BlockKeyParts, beatNumber: number, beatText: string): string {
  return uuidV5(`${blockKey(parts)}|beat:${beatNumber}|${beatText}`);
}
