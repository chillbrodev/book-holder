// Intermediate parse model, mirrors the XML structure, not the DB schema.

export interface ParsedPersona {
  /** Raw <PERSONA> text, e.g. "FENTON, a gentleman." or "Host of the Garter Inn." */
  rawText: string;
}

export interface ParsedLine {
  text: string;
  stageDirection: string | null;
}

// A <SPEECH> is not just SPEAKER+ LINE+, <STAGEDIR> can also appear as a
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
  /** British neural voice, Amy/female and Brian/male (see voices.ts).
   * NULL where the text asserts no gender ("All"), leaving PollyService to
   * fall back to POLLY_DEFAULT_VOICE_ID. */
  polly_voice_id: string | null;
}

/** One row per *beat*, one thought, not one line of verse. See
 * docs/beats-and-blocks-plan.md §2/§5. The table is still called `lines`
 * because it is still the unit `line_mastery` and `mistake_log` key on; what
 * changed is how much text one row holds. */
export interface LineRow {
  id: string;
  play_id: string;
  act: string;
  act_order: number;
  scene: string;
  scene_order: number;
  scene_description: string | null;
  speech_number: number;
  /** Scene-local beat sequence. Was a verse-line number before beats. */
  line_number: number;
  /** The speech-block this beat belongs to, the unit of display and of a
   * single Polly render. Assigned here rather than derived at read time, which
   * is what lets the audio endpoint take a block id instead of a
   * client-supplied ordered array of line ids. */
  block_id: string;
  /** 1-based position within the block. */
  beat_number: number;
  /** The joined beat text: what Polly speaks and what the coach compares
   * against. Not what the screen renders for verse. See source_lines. */
  text: string;
  /** The original <LINE> texts this beat spans, in order. Display renders
   * these so verse keeps its lineation; the joined `text` cannot reproduce it,
   * and that is how a part is memorized.
   *
   * Spans, so adjacent beats can share a line. A beat boundary usually
   * falls mid-line (546 times in Merry Wives), and that line is then the last
   * entry here and the first entry of the next beat, correct per beat, but it
   * means a block's verse is *not* a plain concatenation. Use
   * `render.blockVerseLines`, which reads the flag below. */
  source_lines: string[];
  /** True when this beat's first source line is the same line the previous beat
   * ended on, i.e. the beat boundary fell mid-line. Block-level verse display
   * drops that first entry.
   *
   * Recorded rather than inferred by comparing text, because a song refrain can
   * legitimately repeat an identical line inside one block (2 occurrences
   * across all 37 plays, both in All's Well: "With that she sighed as she
   * stood,"). String equality would silently swallow the repeat. */
  shares_first_source_line: boolean;
  /** Whether the block reads as verse, so display keeps its lineation instead
   * of wrapping it as prose. Moby records no marker; derived from the lineation
   * itself (see blocks.ts). Block-level, so every beat of a block agrees. */
  is_verse: boolean;
  /** An inline <STAGEDIR> nested in the block's first <LINE> (e.g. "[Within]").
   * Only the first beat of a block can carry one, a direction on any later
   * line breaks the block instead, so it keeps its position. */
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
   * the scene yet), lets the app interleave stage directions with lines
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
