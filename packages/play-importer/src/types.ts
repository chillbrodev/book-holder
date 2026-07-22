// Intermediate parse model — mirrors the XML structure, not the DB schema.

export interface ParsedPersona {
  /** Raw <PERSONA> text, e.g. "FENTON, a gentleman." or "Host of the Garter Inn." */
  rawText: string;
}

export interface ParsedLine {
  text: string;
  stageDirection: string | null;
}

// A <SPEECH> is not just SPEAKER+ LINE+ — <STAGEDIR> can also appear as a
// direct child of SPEECH, interleaved between LINEs (e.g. "Knocks", "Enter
// SIMPLE", "Exit SIMPLE" mid-speech while the same character keeps talking).
// Confirmed in the real Merry Wives source: 44 occurrences, always with at
// least one LINE before them in the same speech.
export type SpeechItem =
  | { kind: "line"; text: string; stageDirection: string | null }
  | { kind: "action"; text: string };

export type SceneItem =
  | { kind: "speech"; speakerNames: string[]; items: SpeechItem[] }
  | { kind: "stageDirection"; text: string };

export interface ParsedScene {
  act: string;
  actOrder: number;
  scene: string;
  sceneOrder: number;
  sceneDescription: string | null;
  /** Speeches and scene-level stage directions, in document order. */
  items: SceneItem[];
}

export interface ParsedPlay {
  title: string;
  personae: ParsedPersona[];
  scenes: ParsedScene[];
}

// DB-ready rows (snake_case, matching infra/cockroachdb/migrations column names).

export interface PlayRow {
  id: string;
  title: string;
  source_url: string | null;
}

export interface CharacterRow {
  id: string;
  play_id: string;
  name: string;
  description: string | null;
  is_synthetic: boolean;
}

export interface LineRow {
  id: string;
  play_id: string;
  act: string;
  act_order: number;
  scene: string;
  scene_order: number;
  scene_description: string | null;
  speech_number: number;
  line_number: number;
  text: string;
  stage_direction: string | null;
}

export interface LineSpeakerRow {
  line_id: string;
  character_id: string;
}

export interface StageDirectionRow {
  id: string;
  play_id: string;
  act: string;
  act_order: number;
  scene: string;
  scene_order: number;
  sequence: number;
  /** The scene-local line_number this occurs after (0 if before any line in
   * the scene yet) — lets the app interleave stage directions with lines
   * instead of only knowing their order relative to each other. */
  after_line_number: number;
  text: string;
}

export interface BuiltPlay {
  play: PlayRow;
  characters: CharacterRow[];
  lines: LineRow[];
  lineSpeakers: LineSpeakerRow[];
  stageDirections: StageDirectionRow[];
}
