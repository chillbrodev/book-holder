import type { PoolClient } from "pg";
import { DbClient } from "../../clients/cockroach-db/dbClient.ts";
import { scoreBeat } from "./score.ts";
import { SessionError } from "./errors.ts";

/** What she said for one beat. `heard` is empty when she skipped it — which is
 * information, not a missing field, so it is not optional. */
export type BeatAttempt = {
  lineId: string;
  heard: string;
};

export type SaveSessionInput = {
  userId: string;
  playId: string;
  act: string;
  scene: string;
  durationSeconds: number;
  attempts: BeatAttempt[];
};

export type SavedSession = {
  sessionId: string;
  beatsScored: number;
  beatsMissed: number;
  beatsBlank: number;
};

export type BeatMastery = {
  lineId: string;
  blockId: string;
  beatNumber: number;
  text: string;
  /** Null when she has never practised this beat — different from a score of 0,
   * which means she tried and it didn't land. */
  confidenceScore: number | null;
  mistakeCount: number;
  lastPracticedAt: string | null;
};

export type SessionPlan = {
  totalBeats: number;
  practisedBeats: number;
  /** Beats worth leaning on this run, worst first. Empty on a first-ever run,
   * which is correct: with no history there is nothing to emphasise, and
   * inventing an emphasis would be a static config pretending to be memory. */
  emphasise: BeatMastery[];
};

/** A sane ceiling on a claimed rehearsal length, since the duration comes from the
 * client. Four hours is far past any real session; the point is to keep a
 * malformed or hostile value out of the column, not to police long rehearsals. */
const MAX_DURATION_SECONDS = 4 * 60 * 60;

/** How many beats a plan surfaces. A director gives two or three notes, not
 * twenty — same reasoning as monologue mode's note cap (OPEN_ITEMS §1c). The rest
 * remain in the Prompt Book, which is the place for a full list. */
const MAX_EMPHASISED_BEATS = 5;

/** `pg` returns 64-bit INTs as strings and FLOATs as strings too, hence the
 * unions and the Number() calls at the mapping boundary (BE_PLAN §1a). */
type RawMasteryRow = {
  line_id: string;
  block_id: string;
  beat_number: number | string;
  text: string;
  confidence_score: number | string | null;
  mistake_count: number | string | null;
  last_practiced_at: Date | string | null;
};

function mapMasteryRow(row: RawMasteryRow): BeatMastery {
  return {
    lineId: row.line_id,
    blockId: row.block_id,
    beatNumber: Number(row.beat_number),
    text: row.text,
    confidenceScore: row.confidence_score === null
      ? null
      : Number(row.confidence_score),
    mistakeCount: row.mistake_count === null ? 0 : Number(row.mistake_count),
    lastPracticedAt: row.last_practiced_at === null
      ? null
      : new Date(row.last_practiced_at).toISOString(),
  };
}

export const SessionService = {
  /**
   * Reads what she already knows about this scene and decides what to lean on.
   *
   * This is the *read memory → decide* half of the loop the whole product rests
   * on (`PROJECT_PLAN.md` §2), and it runs once per session start. `BE_PLAN.md` §3
   * warns specifically against letting it decay into a static config: the ordering
   * below comes from her own history, so a beat she has never fluffed cannot be
   * emphasised and a beat she fluffs every time cannot be missed.
   *
   * LEFT JOIN, not JOIN: a beat with no `line_mastery` row has never been
   * practised, and those are the majority on any early run. An inner join would
   * silently return an empty plan and look like "nothing to work on".
   */
  async getSessionPlan(
    input: {
      userId: string;
      playId?: string;
      act?: string;
      scene?: string;
      characterId?: string;
    },
  ): Promise<SessionPlan> {
    const { userId, playId, act, scene, characterId } = input;
    if (
      !playId?.trim() || !act?.trim() || !scene?.trim() || !characterId?.trim()
    ) {
      throw new SessionError(
        "VALIDATION_ERROR",
        "playId, act, scene and characterId are all required.",
      );
    }

    const result = await DbClient.getPool().query(
      `SELECT l.id AS line_id, l.block_id, l.beat_number, l.text,
              m.confidence_score, m.mistake_count, m.last_practiced_at
         FROM lines l
         JOIN line_speakers ls ON ls.line_id = l.id AND ls.character_id = $4
         LEFT JOIN line_mastery m ON m.line_id = l.id AND m.user_id = $5
        WHERE l.play_id = $1 AND l.act = $2 AND l.scene = $3
        ORDER BY l.beat_number`,
      [playId, act, scene, characterId, userId],
    );

    if (result.rows.length === 0) {
      throw new SessionError(
        "SCENE_NOT_FOUND",
        `No beats for character ${characterId} in ${act}.${scene}.`,
      );
    }

    const beats: BeatMastery[] = result.rows.map(mapMasteryRow);
    const practised = beats.filter((beat) => beat.lastPracticedAt !== null);

    // Worst first: most-missed, then least confident. Only beats she has actually
    // attempted are candidates — an unpractised beat isn't a weakness, it's just
    // new, and telling her to focus on something she's never tried is noise.
    const emphasise = [...practised]
      .sort((a, b) =>
        b.mistakeCount - a.mistakeCount ||
        (a.confidenceScore ?? 0) - (b.confidenceScore ?? 0)
      )
      .filter((beat) =>
        beat.mistakeCount > 0 || (beat.confidenceScore ?? 1) < 1
      )
      .slice(0, MAX_EMPHASISED_BEATS);

    return {
      totalBeats: beats.length,
      practisedBeats: practised.length,
      emphasise,
    };
  },

  /**
   * Writes the whole session in one serializable transaction.
   *
   * Everything lands together or nothing does, which matters more here than it
   * looks: a partial write would leave `line_mastery` claiming she practised beats
   * whose `mistake_log` rows never arrived, and there is no way to tell afterwards
   * that it happened. `BE_PLAN.md` §3 asks for one transaction at session end
   * rather than writes scattered through the request lifecycle, and this is it.
   *
   * Nothing is written when she starts, only when she finishes. An abandoned
   * rehearsal therefore leaves no row at all — which is the honest outcome, and
   * avoids orphan `session_history` rows that no `mistake_log` will ever reference.
   */
  async saveSession(input: SaveSessionInput): Promise<SavedSession> {
    const { userId, playId, act, scene, durationSeconds, attempts } = input;

    if (!playId?.trim() || !act?.trim() || !scene?.trim()) {
      throw new SessionError(
        "VALIDATION_ERROR",
        "playId, act and scene are all required.",
      );
    }
    if (!Array.isArray(attempts) || attempts.length === 0) {
      throw new SessionError(
        "VALIDATION_ERROR",
        "A session needs at least one beat attempt to record.",
      );
    }
    if (
      !Number.isFinite(durationSeconds) || durationSeconds < 0 ||
      durationSeconds > MAX_DURATION_SECONDS
    ) {
      throw new SessionError(
        "VALIDATION_ERROR",
        `durationSeconds must be between 0 and ${MAX_DURATION_SECONDS}.`,
      );
    }

    try {
      return await DbClient.withTransaction(async (client) => {
        // Expected text comes from the database, never from the client. The client
        // knows what it displayed, but the answer key is not the client's to
        // supply — a request could otherwise score itself against whatever text it
        // liked.
        const expected = await loadExpectedText(
          client,
          attempts.map((attempt) => attempt.lineId),
        );

        const session = await client.query(
          `INSERT INTO session_history (user_id, play_id, act, scene_range, duration_seconds)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [userId, playId, act, scene, Math.round(durationSeconds)],
        );
        const sessionId: string = session.rows[0].id;

        let beatsScored = 0;
        let beatsMissed = 0;
        let beatsBlank = 0;

        for (const attempt of attempts) {
          const expectedText = expected.get(attempt.lineId);
          // A line id that isn't in this play, or a duplicate the client sent
          // twice. Skipped rather than fatal: losing one beat's score is a much
          // better outcome than throwing away a whole rehearsal she just did.
          if (expectedText === undefined) continue;

          const score = scoreBeat(expectedText, attempt.heard);
          beatsScored++;
          if (score.missed) beatsMissed++;
          if (score.blank) beatsBlank++;

          // confidence_score is the *latest* recall, not a running average: it
          // answers "how well does she know this now". The history lives in
          // mistake_count, which only ever accumulates. Two columns, two
          // questions — an average would blur both into neither.
          await client.query(
            `INSERT INTO line_mastery (user_id, line_id, confidence_score, last_practiced_at, mistake_count)
             VALUES ($1, $2, $3, now(), $4)
             ON CONFLICT (user_id, line_id) DO UPDATE
               SET confidence_score = $3,
                   last_practiced_at = now(),
                   mistake_count = line_mastery.mistake_count + $4`,
            [userId, attempt.lineId, score.recall, score.missed ? 1 : 0],
          );

          // Only misses are logged. mistake_log is the "what went wrong" record
          // that nearest-neighbour search will later run over (OPEN_ITEMS §2), and
          // filling it with correct deliveries would bury the signal it exists
          // for. The blank case is stored as an empty string rather than skipped:
          // "she said nothing here" is one of the most useful things to know.
          if (score.missed) {
            await client.query(
              `INSERT INTO mistake_log (user_id, line_id, session_id, what_was_said)
               VALUES ($1, $2, $3, $4)`,
              [userId, attempt.lineId, sessionId, attempt.heard],
            );
          }
        }

        return { sessionId, beatsScored, beatsMissed, beatsBlank };
      });
    } catch (err) {
      // Retries are exhausted by the time this fires. Named distinctly so the
      // client knows resubmitting the same body is reasonable.
      throw new SessionError(
        "SAVE_FAILED",
        "Couldn't save this rehearsal. The work isn't lost — try again.",
        { cause: err, context: { playId, act, scene } },
      );
    }
  },
};

/** The beats' real text, keyed by id, read inside the transaction. */
async function loadExpectedText(
  client: PoolClient,
  lineIds: string[],
): Promise<Map<string, string>> {
  const result = await client.query(
    `SELECT id, text FROM lines WHERE id = ANY($1::uuid[])`,
    [lineIds],
  );
  return new Map(
    result.rows.map((row: { id: string; text: string }) => [row.id, row.text]),
  );
}
