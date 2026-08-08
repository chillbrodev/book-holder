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

/** One beat she got wrong in a particular run, with what she actually said.
 *
 * `mistakeCount` and `confidenceScore` come from `line_mastery`, so they are her
 * standing record for the beat, not this run's — the wrap-up wants both: what
 * went wrong just now, and whether it is a habit. */
export type FlaggedBeat = BeatMastery & {
  act: string;
  scene: string;
  /** Empty string when she said nothing at all. Stored, not skipped: silence is
   * the single most useful thing to be able to show her. */
  whatWasSaid: string;
};

export type SessionSummary = {
  sessionId: string;
  playId: string;
  act: string;
  scene: string;
  durationSeconds: number;
  /** Null for sessions written before `beats_run` existed (migration 005). Null
   * means "not recorded", which is not the same as 0 and must not render as it. */
  beatsRun: number | null;
  startedAt: string;
  flagged: FlaggedBeat[];
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
   * What actually happened in one rehearsal, for the wrap-up screen.
   *
   * Scoped to `userId` in both queries — the session lookup and the flagged-beat
   * lookup — rather than only the first. A session id is a UUID and hard to
   * guess, but "hard to guess" is not an authorisation check, and the second
   * query would otherwise happily read another user's mistakes given one.
   *
   * `sessionId` is optional because the client usually has no id to give: the
   * rehearsal page fires the save and navigates without waiting for it, so the
   * wrap-up may well ask before the write has landed. Falling back to "her most
   * recent run of this scene" is what makes a page refresh work at all. The
   * client resolves the race by awaiting the save it started (see
   * `pendingSessionSave.ts`); this fallback is for every other way of arriving.
   */
  async getSessionSummary(
    input: {
      userId: string;
      playId?: string;
      act?: string;
      scene?: string;
      sessionId?: string;
    },
  ): Promise<SessionSummary> {
    const { userId, playId, act, scene, sessionId } = input;
    if (!playId?.trim() || !act?.trim() || !scene?.trim()) {
      throw new SessionError(
        "VALIDATION_ERROR",
        "playId, act and scene are all required.",
      );
    }

    // Ordered by started_at, not by insertion: "the run she just did" is the
    // latest one, and a scene rehearsed twice must not show the earlier attempt.
    const session = await DbClient.getPool().query(
      `SELECT id, play_id, act, scene_range, duration_seconds, beats_run, started_at
         FROM session_history
        WHERE user_id = $1 AND play_id = $2 AND act = $3 AND scene_range = $4
          AND ($5::uuid IS NULL OR id = $5::uuid)
        ORDER BY started_at DESC
        LIMIT 1`,
      [userId, playId, act, scene, sessionId?.trim() || null],
    );

    if (session.rows.length === 0) {
      // A real, expected outcome, not a failure: a guest's rehearsal, a
      // single-beat drill, a run where the mic never completed a beat, or a save
      // still in flight. The client shows an honest empty wrap-up for this.
      throw new SessionError(
        "SESSION_NOT_FOUND",
        `No saved rehearsal of ${act}.${scene} for this user.`,
      );
    }

    const row = session.rows[0];

    // LEFT JOIN to line_mastery for the same reason getSessionPlan uses one: the
    // mastery row is written in the same transaction as the mistake, so it should
    // always be there — but a missing one must degrade to "no standing record"
    // rather than dropping a beat she demonstrably got wrong out of the list.
    //
    // Ordered by line_number, not beat_number. `beat_number` is the beat's index
    // *within its block*, so ordering by it interleaves blocks and puts several
    // unrelated "beat 1"s together — two flagged beats from different speeches
    // both come back as 1. `line_number` is the scene-local beat sequence despite
    // its name (CLAUDE.md), so it is the order she actually spoke them in.
    const flagged = await DbClient.getPool().query(
      `SELECT l.id AS line_id, l.block_id, l.beat_number, l.text, l.act, l.scene,
              ml.what_was_said,
              m.confidence_score, m.mistake_count, m.last_practiced_at
         FROM mistake_log ml
         JOIN lines l ON l.id = ml.line_id
         LEFT JOIN line_mastery m ON m.line_id = ml.line_id AND m.user_id = ml.user_id
        WHERE ml.session_id = $1 AND ml.user_id = $2
        ORDER BY l.line_number`,
      [row.id, userId],
    );

    return {
      sessionId: row.id,
      playId: row.play_id,
      act: row.act,
      scene: row.scene_range,
      durationSeconds: Number(row.duration_seconds ?? 0),
      beatsRun: row.beats_run === null ? null : Number(row.beats_run),
      startedAt: new Date(row.started_at).toISOString(),
      flagged: flagged.rows.map((
        beat: RawMasteryRow & {
          act: string;
          scene: string;
          what_was_said: string;
        },
      ) => ({
        ...mapMasteryRow(beat),
        act: beat.act,
        scene: beat.scene,
        whatWasSaid: beat.what_was_said,
      })),
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

        // Counted before the insert rather than after the loop, so `beats_run`
        // lands with the row instead of needing a second UPDATE. The predicate is
        // deliberately the same one the loop below skips on, so the stored count
        // and the returned `beatsScored` can never disagree.
        const beatsRun = attempts.filter((attempt) =>
          expected.has(attempt.lineId)
        ).length;

        const session = await client.query(
          `INSERT INTO session_history (user_id, play_id, act, scene_range, duration_seconds, beats_run)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [userId, playId, act, scene, Math.round(durationSeconds), beatsRun],
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
