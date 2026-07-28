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
};

export type SceneSummaryRow = {
  act: string;
  actOrder: number;
  scene: string;
  sceneOrder: number;
  description: string | null;
  totalLines: number;
};

export type DialogueEntryRow =
  | { type: "stage"; text: string }
  | {
    type: "speech";
    lineId: string;
    lineNumber: number;
    text: string;
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
  text: string;
  speaker_ids: string[];
  speaker_names: string[];
};

function mapLineRow(r: RawLineRow): DialogueEntryRow {
  return {
    type: "speech",
    lineId: r.id,
    lineNumber: Number(r.line_number),
    text: r.text,
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

  async listCharacters(playId: string): Promise<CharacterRow[]> {
    const result = await DbClient.getPool().query(
      `SELECT id, play_id, name, description, is_synthetic
       FROM characters WHERE play_id = $1 ORDER BY name`,
      [playId],
    );
    return result.rows.map((
      r: {
        id: string;
        play_id: string;
        name: string;
        description: string | null;
        is_synthetic: boolean;
      },
    ) => ({
      id: r.id,
      playId: r.play_id,
      name: r.name,
      description: r.description,
      isSynthetic: r.is_synthetic,
    }));
  },

  async listScenes(playId: string): Promise<SceneSummaryRow[]> {
    const result = await DbClient.getPool().query(
      `SELECT act, act_order, scene, scene_order,
              max(scene_description) AS scene_description,
              count(*) AS total_lines
       FROM lines
       WHERE play_id = $1
       GROUP BY act, act_order, scene, scene_order
       ORDER BY act_order, scene_order`,
      [playId],
    );
    return result.rows.map((
      r: {
        act: string;
        act_order: number | string;
        scene: string;
        scene_order: number | string;
        scene_description: string | null;
        total_lines: number | string;
      },
    ) => ({
      act: r.act,
      actOrder: Number(r.act_order),
      scene: r.scene,
      sceneOrder: Number(r.scene_order),
      description: r.scene_description,
      totalLines: Number(r.total_lines),
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
        `SELECT l.id, l.line_number, l.text,
                array_agg(c.id ORDER BY c.name) AS speaker_ids,
                array_agg(c.name ORDER BY c.name) AS speaker_names
         FROM lines l
         JOIN line_speakers ls ON ls.line_id = l.id
         JOIN characters c ON c.id = ls.character_id
         WHERE l.play_id = $1 AND l.act = $2 AND l.scene = $3
         GROUP BY l.id, l.line_number, l.text
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
      `SELECT l.id, l.line_number, l.text,
              array_agg(c.id ORDER BY c.name) AS speaker_ids,
              array_agg(c.name ORDER BY c.name) AS speaker_names
       FROM lines l
       JOIN line_speakers ls ON ls.line_id = l.id
       JOIN characters c ON c.id = ls.character_id
       WHERE l.id = $1
       GROUP BY l.id, l.line_number, l.text`,
      [lineId],
    );
    if (result.rows.length === 0) {
      throw new PlaysError("LINE_NOT_FOUND", `No line with id ${lineId}.`);
    }
    return mapLineRow(result.rows[0]);
  },
};
