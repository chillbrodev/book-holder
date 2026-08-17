import type { PoolClient } from "pg";
import { DbClient } from "../../clients/cockroach-db/dbClient.ts";
import { scoreBeat } from "./score.ts";
import { SessionError } from "./errors.ts";

/** What she said for one beat. `heard` is empty when she skipped it, which is
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
  /** Null when she has never practised this beat, different from a score of 0,
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
 * standing record for the beat, not this run's, the wrap-up wants both: what
 * went wrong just now, and whether it is a habit. */
export type FlaggedBeat = BeatMastery & {
  act: string;
  scene: string;
  /** Empty string when she said nothing at all. Stored, not skipped: silence is
   * the single most useful thing to be able to show her. */
  whatWasSaid: string;
};

/**
 * One of her speeches, as the wrap-up shows it back.
 *
 * The note is the most coach-like thing this app produces and it used to exist
 * only while the scene was on screen, stored in `block_coaching`, rendered
 * live, and then gone the moment she left. Reading it back here is what turns it
 * from a notification into a record.
 */
export type SpeechSummary = {
  blockId: string;
  /** Scene-local order, so the speeches read in the order she spoke them. */
  firstLineNumber: number;
  /** The coach's note, or empty, silence is the right answer more often than
   * not (`coaching-plan.md` §4) and an empty note is not a missing one. */
  note: string;
  /**
   * Every beat of the speech, in the order she said them.
   *
   * This replaced a bare `confidences: number[]`, whose comment claimed the band
   * was "derived from these at render time, never stored". That stopped being
   * true at migration 009: `session_beat_score.band` is what the coach actually
   * judged, and deriving a band from a confidence in the client would have
   * invented a second, disagreeing answer from the same row. The band is read,
   * not recomputed.
   *
   * The text comes with it because the wrap-up now shows the speech back beat by
   * beat, and asking the client to re-fetch the scene to caption its own scores
   * would be a round trip for text this query already has in hand.
   */
  beats: ScoredBeat[];
};

/** One scored beat of a speech, as the wrap-up lists it. */
export type ScoredBeat = {
  lineId: string;
  text: string;
  /** What the coach judged. Null when only the deterministic fallback ever
   * scored this beat — "not judged", never "not solid" (migration 009). */
  band: "solid" | "close" | "dry" | null;
  confidenceScore: number;
};

type RawScoredBeatRow = {
  block_id: string;
  line_number: number | string;
  line_id: string;
  text: string;
  band: "solid" | "close" | "dry" | null;
  confidence_score: number | string;
  note: string;
};

/**
 * Beat rows into speeches, preserving the order they were spoken in.
 *
 * Groups *consecutive* rows sharing a block_id rather than bucketing by id, for
 * the same reason the frontend's `toDialogueItems` does: order is the thing
 * being preserved, and adjacency preserves it for free. The query already
 * orders by `line_number`, which is the scene-local **beat** sequence despite
 * its name — ordering by `beat_number` would interleave speeches, since that is
 * the beat's index *within* its block.
 */
function groupIntoSpeeches(rows: RawScoredBeatRow[]): SpeechSummary[] {
  const speeches: SpeechSummary[] = [];

  for (const row of rows) {
    const beat: ScoredBeat = {
      lineId: row.line_id,
      text: row.text,
      band: row.band,
      // `pg` hands back 64-bit numerics as strings.
      confidenceScore: Number(row.confidence_score),
    };

    const previous = speeches[speeches.length - 1];
    if (previous?.blockId === row.block_id) {
      previous.beats.push(beat);
      continue;
    }

    speeches.push({
      blockId: row.block_id,
      firstLineNumber: Number(row.line_number),
      note: row.note,
      beats: [beat],
    });
  }

  return speeches;
}

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
  /**
   * How much of what she set out to do she got through.
   *
   * This is migration 008's block-scoped session made visible. `blocksPlanned`
   * comes from `session_block`, the intent recorded before she said a word,
   * and `blocksRun` counts the ones that actually have scores. A scene run and a
   * four-speech drill are the same two numbers.
   */
  blocksPlanned: number;
  blocksRun: number;
  /** Set only when every planned block was run to the end. Null is "she stopped
   * early", which is now a kept rehearsal rather than a lost one. */
  completedAt: string | null;
  /** Her speeches this session, each with whatever the coach said about it. */
  speeches: SpeechSummary[];
};

/** A sane ceiling on a claimed rehearsal length, since the duration comes from the
 * client. Four hours is far past any real session; the point is to keep a
 * malformed or hostile value out of the column, not to police long rehearsals. */
const MAX_DURATION_SECONDS = 4 * 60 * 60;

/** How many beats a plan surfaces. A director gives two or three notes, not
 * twenty, same reasoning as monologue mode's note cap (OPEN_ITEMS §1c). The rest
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
  /**
   * Her whole part, and what she still hasn't got.
   *
   * The Prompt Book answers a different question from the wrap-up. The wrap-up
   * is "how did that run go"; this is "where am I with this part", which no
   * single session can answer, so it reads `line_mastery`, which is keyed
   * (user, line) and has no concept of a session at all.
   *
   * Three numbers, deliberately distinct:
   *
   *   totalBeats      every beat of the part, run or not
   *   practisedBeats  beats she has attempted, how far in she is
   *   solidBeats      beats she currently *has*, the mastery bar
   *
   * `solidBeats` counts `band = 'solid'` and never `band <> 'dry'`, because NULL
   * means the deterministic fallback scored the beat and no band was ever judged
   * (migration 009). Counting NULL as known would let a Bedrock outage inflate
   * her mastery.
   */
  async getPromptBook(
    input: { userId: string; playId?: string; characterId?: string },
  ): Promise<PromptBook> {
    const { userId, playId, characterId } = input;
    if (!playId?.trim() || !characterId?.trim()) {
      throw new SessionError(
        "VALIDATION_ERROR",
        "playId and characterId are both required.",
      );
    }

    const head = await DbClient.getPool().query(
      `SELECT p.title AS play_title, c.name AS character_name
         FROM plays p JOIN characters c ON c.play_id = p.id
        WHERE p.id = $1 AND c.id = $2`,
      [playId, characterId],
    );
    if (head.rows.length === 0) {
      throw new SessionError(
        "SCENE_NOT_FOUND",
        `No character ${characterId} in play ${playId}.`,
      );
    }

    // LEFT JOIN for the same reason getSessionPlan uses one: most of a part has
    // never been run, and an inner join would report a 40-beat role as a 3-beat
    // one on her second day.
    const totals = await DbClient.getPool().query(
      `SELECT count(*) AS total,
              count(m.line_id) AS practised,
              count(*) FILTER (WHERE m.band = 'solid') AS solid
         FROM lines l
         JOIN line_speakers ls ON ls.line_id = l.id AND ls.character_id = $2
         LEFT JOIN line_mastery m ON m.line_id = l.id AND m.user_id = $3
        WHERE l.play_id = $1`,
      [playId, characterId, userId],
    );

    // Worst first, most-missed, then least confident, then most recent. Only
    // beats she has actually got wrong: an unpractised beat is not a weakness,
    // it is just unvisited, and listing it here would bury the real notes under
    // the whole part.
    //
    // `what_was_said` is her most recent attempt at that beat, not any older
    // one, a lateral join rather than a join to mistake_log, which holds every
    // miss ever and would multiply the rows.
    const flagged = await DbClient.getPool().query(
      `SELECT l.id AS line_id, l.block_id, l.act, l.scene, l.text,
              m.mistake_count, m.band, m.confidence_score, m.last_practiced_at,
              coalesce(recent.what_was_said, '') AS what_was_said
         FROM line_mastery m
         JOIN lines l ON l.id = m.line_id
         JOIN line_speakers ls ON ls.line_id = l.id AND ls.character_id = $2
         LEFT JOIN LATERAL (
           SELECT ml.what_was_said
             FROM mistake_log ml
            WHERE ml.line_id = m.line_id AND ml.user_id = m.user_id
            ORDER BY ml.created_at DESC
            LIMIT 1
         ) recent ON true
        WHERE m.user_id = $3 AND l.play_id = $1 AND m.mistake_count > 0
        ORDER BY m.mistake_count DESC, m.confidence_score ASC, m.last_practiced_at DESC
        LIMIT $4`,
      [playId, characterId, userId, PROMPT_BOOK_LIMIT],
    );

    return {
      playId,
      playTitle: head.rows[0].play_title,
      characterId,
      characterName: head.rows[0].character_name,
      totalBeats: Number(totals.rows[0].total),
      practisedBeats: Number(totals.rows[0].practised),
      solidBeats: Number(totals.rows[0].solid),
      needsAnotherLook: flagged.rows.map((
        row: RawMasteryRow & {
          act: string;
          scene: string;
          band: string | null;
          what_was_said: string;
        },
      ) => ({
        lineId: row.line_id,
        blockId: row.block_id,
        act: row.act,
        scene: row.scene,
        text: row.text,
        mistakeCount: Number(row.mistake_count ?? 0),
        band: row.band,
        confidenceScore: Number(row.confidence_score ?? 0),
        whatWasSaid: row.what_was_said,
        lastPractisedAt: row.last_practiced_at === null
          ? null
          : new Date(row.last_practiced_at).toISOString(),
      })),
    };
  },

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
    // attempted are candidates, an unpractised beat isn't a weakness, it's just
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
   * Scoped to `userId` in both queries, the session lookup and the flagged-beat
   * lookup, rather than only the first. A session id is a UUID and hard to
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
      `SELECT id, play_id, act, scene_range, duration_seconds, beats_run, started_at, completed_at
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
    // always be there, but a missing one must degrade to "no standing record"
    // rather than dropping a beat she demonstrably got wrong out of the list.
    //
    // Ordered by line_number, not beat_number. `beat_number` is the beat's index
    // *within its block*, so ordering by it interleaves blocks and puts several
    // unrelated "beat 1"s together, two flagged beats from different speeches
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

    /**
     * Her speeches, with the coach's note and the beat scores side by side.
     *
     * LEFT JOIN from `session_beat_score` rather than from `block_coaching`,
     * because a speech she ran always has scores and only *sometimes* has a
     * note, joining the other way would hide every speech the coach had
     * nothing to say about, which is most of the good ones.
     *
     * Ordered by `line_number` for the reason recorded above `flagged`:
     * `beat_number` is the beat's index within its block, so ordering by it
     * interleaves speeches and puts several unrelated "beat 1"s together.
     */
    const speeches = await DbClient.getPool().query(
      // One row per beat rather than one aggregated row per speech, and grouped
      // in TypeScript below. Aggregating four parallel arrays (id, text, band,
      // confidence) and trusting them to stay aligned is the kind of thing that
      // is correct until one column is added to only three of the array_aggs.
      `SELECT l.block_id,
              l.line_number,
              l.id AS line_id,
              l.text,
              sbs.band,
              sbs.confidence_score,
              coalesce(bc.note, '') AS note
         FROM session_beat_score sbs
         JOIN lines l ON l.id = sbs.line_id
         LEFT JOIN block_coaching bc
                ON bc.session_id = sbs.session_id AND bc.block_id = l.block_id
        WHERE sbs.session_id = $1
        ORDER BY l.line_number`,
      [row.id],
    );

    // Intent versus achievement, which is the whole point of migration 008.
    // `blocksPlanned` is what she set out to run, recorded before she started;
    // `blocksRun` is what actually has scores against it.
    const coverage = await DbClient.getPool().query(
      `SELECT
         (SELECT count(*) FROM session_block WHERE session_id = $1) AS planned,
         (SELECT count(DISTINCT l.block_id)
            FROM session_beat_score sbs
            JOIN lines l ON l.id = sbs.line_id
           WHERE sbs.session_id = $1) AS run`,
      [row.id],
    );

    return {
      sessionId: row.id,
      playId: row.play_id,
      act: row.act,
      scene: row.scene_range,
      durationSeconds: Number(row.duration_seconds ?? 0),
      beatsRun: row.beats_run === null ? null : Number(row.beats_run),
      startedAt: new Date(row.started_at).toISOString(),
      completedAt: row.completed_at === null
        ? null
        : new Date(row.completed_at).toISOString(),
      blocksPlanned: Number(coverage.rows[0]?.planned ?? 0),
      blocksRun: Number(coverage.rows[0]?.run ?? 0),
      speeches: groupIntoSpeeches(speeches.rows),
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
   * rehearsal therefore leaves no row at all, which is the honest outcome, and
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
        // supply, a request could otherwise score itself against whatever text it
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
          // questions; an average would blur both into neither.
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

/** One beat she has missed, with what she actually said the last time. */
export type PromptBookBeat = {
  lineId: string;
  blockId: string;
  act: string;
  scene: string;
  text: string;
  /** How many times she has missed it, ever, `line_mastery.mistake_count`,
   * which only accumulates. Worst-first ordering keys on this. */
  mistakeCount: number;
  /** The latest attempt's band, or null when only the deterministic fallback
   * has scored it (migration 009). */
  band: string | null;
  confidenceScore: number;
  /** Empty when she said nothing at all, the most useful thing to show. */
  whatWasSaid: string;
  lastPractisedAt: string | null;
};

export type PromptBook = {
  playId: string;
  playTitle: string;
  characterId: string;
  characterName: string;
  /** Every beat of the part, whether or not she has ever run it. */
  totalBeats: number;
  /** Beats she has attempted at all, the honest denominator for "how far
   * through the part am I", and deliberately separate from `solidBeats`. */
  practisedBeats: number;
  /** Beats whose latest band is *solid*. `band = 'solid'`, never
   * `band <> 'dry'`, NULL means the fallback scored it and no band was ever
   * judged (migration 009), which must not count as known. */
  solidBeats: number;
  /** Worst first. Her whole part, not one scene; this is the screen for "what
   * do I still not have", which a per-scene wrap-up cannot answer. */
  needsAnotherLook: PromptBookBeat[];
};

/**
 * How many notes to carry. A prompt book that lists forty lines is a list, not
 * a prompt book, `OPEN_ITEMS.md` §1c's "a director gives two or three" applied
 * one level up, to the part rather than the speech.
 */
const PROMPT_BOOK_LIMIT = 12;
