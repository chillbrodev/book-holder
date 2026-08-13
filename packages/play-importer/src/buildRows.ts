import { randomUUID } from "node:crypto";
import { assignVerseFlags } from "./blocks.js";
import { beatId, blockId } from "./ids.js";
import { joinVerseLines, splitIntoBeats } from "./segment.js";
import { voiceFor } from "./voices.js";
import type {
  BuiltPlay,
  CharacterRow,
  LineRow,
  LineSpeakerRow,
  ParsedLine,
  ParsedPlay,
  SpeechItem,
  StageDirectionRow,
} from "./types.js";

function normalizeKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toUpperCase();
}

/** Splits a <PERSONA> line into a name guess and trailing description, on the
 * first comma, e.g. "FENTON, a gentleman." -> ("FENTON", "a gentleman."). */
function splitPersona(rawText: string): { nameGuess: string; description: string | null } {
  const commaIndex = rawText.indexOf(",");
  if (commaIndex === -1) return { nameGuess: rawText.trim(), description: null };
  return {
    nameGuess: rawText.slice(0, commaIndex).trim(),
    description: rawText.slice(commaIndex + 1).trim() || null,
  };
}

const CHORUS_KEY = "__CHORUS__";
const ALL_KEY = "ALL";

/** A run of consecutive lines within one speech, uninterrupted by any stage
 * direction, the unit of display and of a single Polly render. */
type SpeechBlock =
  | { kind: "lines"; lines: ParsedLine[] }
  | { kind: "action"; text: string };

/**
 * Cuts a speech into blocks at every stage direction, so a direction keeps its
 * position instead of being swallowed by the surrounding speech (44 of these
 * fall inside a speech in Merry Wives alone).
 *
 * Two things break a block:
 *  - a <STAGEDIR> sibling of <LINE> ("Knocks" mid-speech), and
 *  - a <LINE> carrying its own nested <STAGEDIR> when it isn't the first line
 *    of the block. That direction prefixes its line's text, so cutting before
 *    it is what keeps it in the right place, and it means only a block's
 *    *first* line can carry one, which is why LineRow.stage_direction is a
 *    single value with nothing to drop.
 */
function splitSpeechIntoBlocks(items: SpeechItem[]): SpeechBlock[] {
  const blocks: SpeechBlock[] = [];
  let current: ParsedLine[] = [];

  const flush = () => {
    if (current.length > 0) blocks.push({ kind: "lines", lines: current });
    current = [];
  };

  for (const item of items) {
    if (item.kind === "action") {
      flush();
      blocks.push({ kind: "action", text: item.text });
      continue;
    }
    if (item.stageDirection && current.length > 0) flush();
    current.push({ text: item.text, stageDirection: item.stageDirection });
  }

  flush();
  return blocks;
}

interface CharacterIdentity {
  key: string;
  displayName: string;
  description: string | null;
  isSynthetic: boolean;
}

/** A blank <SPEAKER></SPEAKER> (Prologue/Chorus, parsing rule 4) or the literal
 * "ALL" (unison lines, parsing rule 5) map to synthetic characters. Everything
 * else is a real speaking role, whether or not it's in the PERSONAE list. */
function resolveSpeakerKey(rawSpeakerName: string): {
  key: string;
  displayName: string;
  isSynthetic: boolean;
} {
  // "[PROSPERO]" (the Tempest epilogue, the corpus's only bracketed speaker)
  // must resolve to the same character as "PROSPERO", or he ends up with two
  // rows and the epilogue detaches from the part.
  const trimmed = rawSpeakerName.trim().replace(/^[[(]\s*|\s*[\])]$/g, "").trim();
  if (trimmed === "") {
    return { key: CHORUS_KEY, displayName: "Chorus", isSynthetic: true };
  }
  const key = normalizeKey(trimmed);
  if (key === ALL_KEY) {
    return { key: ALL_KEY, displayName: "All", isSynthetic: true };
  }
  return { key, displayName: trimmed, isSynthetic: false };
}

/**
 * Character identity is derived from actual <SPEAKER> usage in the script body,
 * not from the <PERSONAE> cast list. The two don't line up 1:1 (Moby Shakespeare
 * transcription rule 7): e.g. PERSONAE has "Host of the Garter Inn." but the
 * script only ever uses SPEAKER "Host"; "First Servant"/"Second Servant" never
 * appear in PERSONAE at all. Deriving identity from usage means every speaking
 * role gets a row; PERSONAE is only consulted afterward, best-effort, to add
 * flavor-text descriptions, never to gate whether a character gets created.
 */
export function buildRows(parsed: ParsedPlay, sourceUrl: string | null): BuiltPlay {
  const playId = randomUUID();

  // Pass 1: collect unique speaker identities, first-seen order.
  const identities = new Map<string, CharacterIdentity>();
  for (const scene of parsed.scenes) {
    for (const item of scene.items) {
      if (item.kind !== "speech") continue;
      for (const rawName of item.speakerNames) {
        const { key, displayName, isSynthetic } = resolveSpeakerKey(rawName);
        if (!identities.has(key)) {
          identities.set(key, { key, displayName, description: null, isSynthetic });
        }
      }
    }
  }

  // Best-effort description enrichment from PERSONAE: exact match first, then
  // a prefix fallback for cases like SPEAKER "Host" vs PERSONA "Host of the
  // Garter Inn." Not critical-path, nothing downstream depends on getting
  // every description right, this is flavor text only.
  const personaEntries = parsed.personae.map((p) => splitPersona(p.rawText));
  const exactMap = new Map<string, string | null>();
  for (const { nameGuess, description } of personaEntries) {
    exactMap.set(normalizeKey(nameGuess), description);
  }

  for (const identity of identities.values()) {
    if (identity.isSynthetic) continue;
    if (exactMap.has(identity.key)) {
      identity.description = exactMap.get(identity.key) ?? null;
      continue;
    }
    for (const { nameGuess, description } of personaEntries) {
      const fullRaw = description ? `${nameGuess}, ${description}` : nameGuess;
      const fullKey = normalizeKey(fullRaw);
      if (fullKey === identity.key) continue; // would already be in exactMap
      if (fullKey.startsWith(identity.key + " ")) {
        const remainder = fullRaw.slice(identity.key.length).trim().replace(/^[,.]\s*/, "");
        identity.description = remainder || null;
        break;
      }
    }
  }

  const characterIdByKey = new Map<string, string>();
  const characters: CharacterRow[] = [];
  let unknownPlayVoices = false;
  for (const identity of identities.values()) {
    const id = randomUUID();
    characterIdByKey.set(identity.key, id);
    const { voiceId, unknownPlay } = voiceFor(parsed.title, identity.displayName);
    unknownPlayVoices ||= unknownPlay;
    characters.push({
      id,
      play_id: playId,
      name: identity.displayName,
      description: identity.description,
      is_synthetic: identity.isSynthetic,
      polly_voice_id: voiceId,
    });
  }
  if (unknownPlayVoices) {
    // Loud rather than silent: with no curated list every character would take
    // the male voice, and that only shows up as a wrong-sounding rehearsal
    // after a full paid warm run.
    console.warn(
      `WARNING: no voice list for "${parsed.title}" (see src/voices.ts) — ` +
        `every character will fall back to POLLY_DEFAULT_VOICE_ID.`
    );
  }

  // Pass 2: walk scenes again, now that every speaker resolves to a character id.
  const lines: LineRow[] = [];
  const lineSpeakers: LineSpeakerRow[] = [];
  const stageDirections: StageDirectionRow[] = [];

  for (const scene of parsed.scenes) {
    let speechNumber = 0;
    // Scene-local beat sequence, populates LineRow.line_number, and anchors
    // stage directions via after_line_number.
    let lineNumber = 0;
    let stageDirSequence = 0;
    // Scene-local block sequence: only used to break id ties, see ids.ts.
    let blockIndex = 0;

    for (const item of scene.items) {
      if (item.kind === "stageDirection") {
        stageDirections.push({
          id: randomUUID(),
          play_id: playId,
          act: scene.act,
          act_order: scene.actOrder,
          scene: scene.scene,
          scene_order: scene.sceneOrder,
          sequence: stageDirSequence++,
          after_line_number: lineNumber,
          text: item.text,
        });
        continue;
      }

      speechNumber += 1;
      const speakerIds = item.speakerNames.map((rawName) => {
        const { key } = resolveSpeakerKey(rawName);
        const id = characterIdByKey.get(key);
        if (!id) throw new Error(`Unresolved speaker key: ${key}`);
        return id;
      });

      const pushStageDirection = (text: string) => {
        stageDirections.push({
          id: randomUUID(),
          play_id: playId,
          act: scene.act,
          act_order: scene.actOrder,
          scene: scene.scene,
          scene_order: scene.sceneOrder,
          sequence: stageDirSequence++,
          after_line_number: lineNumber,
          text,
        });
      };

      for (const block of splitSpeechIntoBlocks(item.items)) {
        if (block.kind === "action") {
          // Mid-speech stage direction (e.g. "Knocks" between two lines of
          // the same speaker), same table as scene-level ones, anchored to
          // the beat it follows via after_line_number.
          pushStageDirection(block.text);
          continue;
        }

        const joined = joinVerseLines(block.lines.map((l) => l.text));
        const beats = splitIntoBeats(joined.text);

        if (beats.length === 0) {
          // A <LINE> holding only a <STAGEDIR> and no spoken text. Keep the cue
          // rather than dropping it with the empty block.
          const direction = block.lines.find((l) => l.stageDirection)?.stageDirection;
          if (direction) pushStageDirection(direction);
          continue;
        }

        const keyParts = {
          playTitle: parsed.title,
          act: scene.act,
          scene: scene.scene,
          blockIndex: blockIndex++,
          speakers: item.speakerNames,
          text: joined.text,
        };
        const currentBlockId = blockId(keyParts);
        let cursor = 0;
        let previousLastLine = -1;

        beats.forEach((beatText, index) => {
          // Every beat is an exact substring of the joined text (segment.ts),
          // so offsets map it back onto the verse lines it spans. Throwing here
          // beats silently attributing a beat to the wrong lines.
          const start = joined.text.indexOf(beatText, cursor);
          if (start === -1) {
            throw new Error(
              `Beat not found in joined speech ${scene.act}/${scene.scene} #${speechNumber}: ${beatText}`
            );
          }
          const end = start + beatText.length;
          cursor = end;

          const spannedIndices = block.lines
            .map((_, i) => i)
            .filter((i) => joined.lineRanges[i].start < end && joined.lineRanges[i].end > start);
          const sourceLines = spannedIndices.map((i) => block.lines[i].text);
          // Compared by line index, not by text; a song refrain can repeat an
          // identical line inside one block, and equality would misread that as
          // a straddled boundary.
          const sharesFirst = spannedIndices[0] === previousLastLine;
          previousLastLine = spannedIndices[spannedIndices.length - 1];

          lineNumber += 1;
          const lineId = beatId(keyParts, index + 1, beatText);
          lines.push({
            id: lineId,
            play_id: playId,
            act: scene.act,
            act_order: scene.actOrder,
            scene: scene.scene,
            scene_order: scene.sceneOrder,
            scene_description: scene.sceneDescription,
            speech_number: speechNumber,
            line_number: lineNumber,
            block_id: currentBlockId,
            beat_number: index + 1,
            text: beatText,
            source_lines: sourceLines,
            shares_first_source_line: sharesFirst,
            is_verse: false, // set by assignVerseFlags once the play is built

            stage_direction: index === 0 ? block.lines[0].stageDirection : null,
          });
          for (const characterId of speakerIds) {
            lineSpeakers.push({ line_id: lineId, character_id: characterId });
          }
        });
      }
    }
  }

  // Needs the whole play: a block too short to classify inherits the play's
  // dominant mode, which isn't known until every block exists.
  assignVerseFlags(lines);

  return {
    play: { id: playId, title: parsed.title, source_url: sourceUrl },
    characters,
    lines,
    lineSpeakers,
    stageDirections,
  };
}
