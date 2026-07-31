import { DbClient } from "../../clients/cockroach-db/dbClient.ts";
import { PlaysError } from "./errors.ts";

export type PlayRow = {
  id: string;
  title: string;
  sourceUrl: string | null;
  createdAt: string;
};

export type CharacterRow = {
  id: string;
  playId: string;
  name: string;
  description: string | null;
  isSynthetic: boolean;
  /** Beats attributed to this character anywhere in the play — rows in
   * `lines`, which since migration 004 hold one thought each, not one line of
   * verse and not a whole speech. Copy that says "lines" to the user is
   * counting these. */
  lineCount: number;
  /** Distinct act+scene pairs the character speaks in. */
  sceneCount: number;
};

export type SceneSummaryRow = {
  act: string;
  actOrder: number;
  scene: string;
  sceneOrder: number;
  description: string | null;
  totalLines: number;
  /** Beats spoken in this scene by the character listScenes was called for,
   * or 0 when it was called without one. Lets the scene picker lead with the
   * scenes a part is actually in — for a 12-beat role, a flat list of all 23
   * scenes buries the one that matters. */
  characterLines: number;
};

/** One *beat* — one thought, which is what the coach scores and what
 * line_mastery keys on. Display and Polly work on the block it belongs to; see
 * docs/beats-and-blocks-plan.md §2. */
export type DialogueEntryRow =
  | { type: "stage"; text: string }
  | {
    type: "speech";
    lineId: string;
    lineNumber: number;
    /** The speech-block this beat belongs to — a speech, cut wherever a stage
     * direction falls inside it. Assigned at import, not derived here: only
     * the importer knows where a direction split a speech, and persisting it
     * is what lets the audio endpoint take a block id instead of a
     * client-supplied ordered array of line ids. */
    blockId: string;
    beatNumber: number;
    /** The joined beat text — what Polly speaks and what a transcript is
     * compared against. For a verse block this is *not* what the screen
     * shows; sourceLines is. */
    text: string;
    sourceLines: string[];
    /** sourceLines[0] repeats the previous beat's last line (the boundary fell
     * mid-line), so block-level verse display drops it. */
    sharesFirstSourceLine: boolean;
    /** Block-level: verse keeps its lineation on screen, prose is wrapped. */
    isVerse: boolean;
    // Ordered by character name for determinism — line_speakers is an
    // unordered many-to-many join (BE_PLAN.md §1a), so there's no real
    // "primary speaker" for the rare jointly-spoken line. Callers that need
    // one voice (e.g. Polly playback) take speakerIds[0].
    speakerIds: string[];
    speakerNames: string[];
  };

// line_number/act_order/scene_order/after_line_number are all CockroachDB
// INT (64-bit) — pg returns those as strings, not numbers, to avoid silent
// precision loss past Number.MAX_SAFE_INTEGER (same reason auth/service.ts
// explicitly Number()s failed_pin_attempts). Every raw row type below
// reflects that; Number() at the mapping boundary is deliberate, not
// decoration.
type RawLineRow = {
  id: string;
  line_number: number | string;
  block_id: string;
  beat_number: number | string;
  text: string;
  source_lines: string[];
  shares_first_source_line: boolean;
  is_verse: boolean;
  speaker_ids: string[];
  speaker_names: string[];
};

/** The columns every beat query needs, kept in one place so getSceneDialogue
 * and getLine can't drift apart — they feed the same client-side grouping. */
const BEAT_COLUMNS = `l.id, l.line_number, l.block_id, l.beat_number, l.text,
        l.source_lines, l.shares_first_source_line, l.is_verse`;

function mapLineRow(r: RawLineRow): DialogueEntryRow {
  return {
    type: "speech",
    lineId: r.id,
    lineNumber: Number(r.line_number),
    blockId: r.block_id,
    beatNumber: Number(r.beat_number),
    text: r.text,
    sourceLines: r.source_lines,
    sharesFirstSourceLine: r.shares_first_source_line,
    isVerse: r.is_verse,
    speakerIds: r.speaker_ids,
    speakerNames: r.speaker_names,
  };
}

export const PlaysService = {
  async listPlays(): Promise<PlayRow[]> {
    const result = await DbClient.getPool().query(
      "SELECT id, title, source_url, created_at FROM plays ORDER BY created_at",
    );
    return result.rows.map((
      r: {
        id: string;
        title: string;
        source_url: string | null;
        created_at: string;
      },
    ) => ({
      id: r.id,
      title: r.title,
      sourceUrl: r.source_url,
      createdAt: r.created_at,
    }));
  },

  /** LEFT JOINs so a character with no attributed lines still comes back (at
   * 0/0) rather than vanishing from the role picker. scene_count concatenates
   * act/scene rather than counting a tuple because `||` yields NULL for a
   * character with no lines, which count() then skips — a tuple would count
   * as one. */
  async listCharacters(playId: string): Promise<CharacterRow[]> {
    const result = await DbClient.getPool().query(
      `SELECT c.id, c.play_id, c.name, c.description, c.is_synthetic,
              count(l.id) AS line_count,
              count(DISTINCT l.act || ':' || l.scene) AS scene_count
       FROM characters c
       LEFT JOIN line_speakers ls ON ls.character_id = c.id
       LEFT JOIN lines l ON l.id = ls.line_id
       WHERE c.play_id = $1
       GROUP BY c.id, c.play_id, c.name, c.description, c.is_synthetic
       ORDER BY c.name`,
      [playId],
    );
    return result.rows.map((
      r: {
        id: string;
        play_id: string;
        name: string;
        description: string | null;
        is_synthetic: boolean;
        line_count: number | string;
        scene_count: number | string;
      },
    ) => ({
      id: r.id,
      playId: r.play_id,
      name: r.name,
      description: r.description,
      isSynthetic: r.is_synthetic,
      lineCount: Number(r.line_count),
      sceneCount: Number(r.scene_count),
    }));
  },

  /** The LEFT JOIN is filtered to one character in its ON clause, not the
   * WHERE — so scenes the character isn't in still come back (at 0), and each
   * line still contributes exactly one row, keeping count(*) an honest total.
   * count(ls.line_id) then counts only the matched rows. Passing a null
   * characterId matches nothing, so characterLines is 0 throughout. */
  async listScenes(
    playId: string,
    characterId?: string,
  ): Promise<SceneSummaryRow[]> {
    const result = await DbClient.getPool().query(
      `SELECT l.act, l.act_order, l.scene, l.scene_order,
              max(l.scene_description) AS scene_description,
              count(*) AS total_lines,
              count(ls.line_id) AS character_lines
       FROM lines l
       LEFT JOIN line_speakers ls ON ls.line_id = l.id AND ls.character_id = $2
       WHERE l.play_id = $1
       GROUP BY l.act, l.act_order, l.scene, l.scene_order
       ORDER BY l.act_order, l.scene_order`,
      [playId, characterId ?? null],
    );
    return result.rows.map((
      r: {
        act: string;
        act_order: number | string;
        scene: string;
        scene_order: number | string;
        scene_description: string | null;
        total_lines: number | string;
        character_lines: number | string;
      },
    ) => ({
      act: r.act,
      actOrder: Number(r.act_order),
      scene: r.scene,
      sceneOrder: Number(r.scene_order),
      description: r.scene_description,
      totalLines: Number(r.total_lines),
      characterLines: Number(r.character_lines),
    }));
  },

  /** Interleaves lines and stage directions into one ordered stream, same
   * merge rule as the frontend's mock buildSceneDialogue: a direction with
   * after_line_number = N sorts immediately before line N. Doesn't compute
   * isUserLine — that depends on which character the browser has locally
   * selected to rehearse as, which this endpoint has no notion of. */
  async getSceneDialogue(
    playId: string,
    act: string,
    scene: string,
  ): Promise<DialogueEntryRow[]> {
    const pool = DbClient.getPool();
    const [lines, directions] = await Promise.all([
      pool.query(
        `SELECT ${BEAT_COLUMNS},
                array_agg(c.id ORDER BY c.name) AS speaker_ids,
                array_agg(c.name ORDER BY c.name) AS speaker_names
         FROM lines l
         JOIN line_speakers ls ON ls.line_id = l.id
         JOIN characters c ON c.id = ls.character_id
         WHERE l.play_id = $1 AND l.act = $2 AND l.scene = $3
         GROUP BY ${BEAT_COLUMNS}
         ORDER BY l.line_number`,
        [playId, act, scene],
      ),
      pool.query(
        `SELECT after_line_number, sequence, text
         FROM stage_directions
         WHERE play_id = $1 AND act = $2 AND scene = $3
         ORDER BY after_line_number, sequence`,
        [playId, act, scene],
      ),
    ]);

    type Sortable = {
      sortKey: number;
      tiebreak: number;
      entry: DialogueEntryRow;
    };
    const sortable: Sortable[] = [
      ...lines.rows.map((r: RawLineRow): Sortable => ({
        sortKey: Number(r.line_number),
        tiebreak: 1,
        entry: mapLineRow(r),
      })),
      ...directions.rows.map((
        r: {
          after_line_number: number | string;
          sequence: number | string;
          text: string;
        },
      ): Sortable => ({
        sortKey: Number(r.after_line_number),
        tiebreak: 0,
        entry: { type: "stage", text: r.text },
      })),
    ];

    sortable.sort((a, b) => a.sortKey - b.sortKey || a.tiebreak - b.tiebreak);
    return sortable.map((s) => s.entry);
  },

  async getLine(lineId: string): Promise<DialogueEntryRow> {
    const result = await DbClient.getPool().query(
      `SELECT ${BEAT_COLUMNS},
              array_agg(c.id ORDER BY c.name) AS speaker_ids,
              array_agg(c.name ORDER BY c.name) AS speaker_names
       FROM lines l
       JOIN line_speakers ls ON ls.line_id = l.id
       JOIN characters c ON c.id = ls.character_id
       WHERE l.id = $1
       GROUP BY ${BEAT_COLUMNS}`,
      [lineId],
    );
    if (result.rows.length === 0) {
      throw new PlaysError("LINE_NOT_FOUND", `No line with id ${lineId}.`);
    }
    return mapLineRow(result.rows[0]);
  },

  /** Every beat of the block a given beat belongs to, in order.
   *
   * What the Prompt Book's single-beat drill (`?line=`) should open: a beat is
   * one thought, and practising it with no run-up into it isn't how the speech
   * is delivered. The caller highlights the requested beat within the block. */
  async getBlockForLine(lineId: string): Promise<DialogueEntryRow[]> {
    const result = await DbClient.getPool().query(
      `SELECT ${BEAT_COLUMNS},
              array_agg(c.id ORDER BY c.name) AS speaker_ids,
              array_agg(c.name ORDER BY c.name) AS speaker_names
       FROM lines l
       JOIN line_speakers ls ON ls.line_id = l.id
       JOIN characters c ON c.id = ls.character_id
       WHERE l.block_id = (SELECT block_id FROM lines WHERE id = $1)
       GROUP BY ${BEAT_COLUMNS}
       ORDER BY l.beat_number`,
      [lineId],
    );
    if (result.rows.length === 0) {
      throw new PlaysError("LINE_NOT_FOUND", `No line with id ${lineId}.`);
    }
    return result.rows.map(mapLineRow);
  },
};
