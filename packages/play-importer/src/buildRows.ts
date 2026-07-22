import { randomUUID } from "node:crypto";
import type {
  BuiltPlay,
  CharacterRow,
  LineRow,
  LineSpeakerRow,
  ParsedPlay,
  StageDirectionRow,
} from "./types.js";

function normalizeKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toUpperCase();
}

/** Splits a <PERSONA> line into a name guess and trailing description, on the
 * first comma — e.g. "FENTON, a gentleman." -> ("FENTON", "a gentleman."). */
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
  const trimmed = rawSpeakerName.trim();
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
 * flavor-text descriptions — never to gate whether a character gets created.
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
  // Garter Inn." Not critical-path — nothing downstream depends on getting
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
  for (const identity of identities.values()) {
    const id = randomUUID();
    characterIdByKey.set(identity.key, id);
    characters.push({
      id,
      play_id: playId,
      name: identity.displayName,
      description: identity.description,
      is_synthetic: identity.isSynthetic,
    });
  }

  // Pass 2: walk scenes again, now that every speaker resolves to a character id.
  const lines: LineRow[] = [];
  const lineSpeakers: LineSpeakerRow[] = [];
  const stageDirections: StageDirectionRow[] = [];

  for (const scene of parsed.scenes) {
    let speechNumber = 0;
    let lineNumber = 0;
    let stageDirSequence = 0;

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

      for (const speechItem of item.items) {
        if (speechItem.kind === "action") {
          // Mid-speech stage direction (e.g. "Knocks" between two lines of
          // the same speaker) — same table as scene-level ones, anchored to
          // the line it follows via after_line_number.
          stageDirections.push({
            id: randomUUID(),
            play_id: playId,
            act: scene.act,
            act_order: scene.actOrder,
            scene: scene.scene,
            scene_order: scene.sceneOrder,
            sequence: stageDirSequence++,
            after_line_number: lineNumber,
            text: speechItem.text,
          });
          continue;
        }

        lineNumber += 1;
        const lineId = randomUUID();
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
          text: speechItem.text,
          stage_direction: speechItem.stageDirection,
        });
        for (const characterId of speakerIds) {
          lineSpeakers.push({ line_id: lineId, character_id: characterId });
        }
      }
    }
  }

  return {
    play: { id: playId, title: parsed.title, source_url: sourceUrl },
    characters,
    lines,
    lineSpeakers,
    stageDirections,
  };
}
