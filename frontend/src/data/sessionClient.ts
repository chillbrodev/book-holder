import { apiRequest } from './apiClient'

/**
 * The memory half of the loop: what to lean on before a scene, and what happened
 * after it.
 *
 * Both endpoints require a signed-in user, because `session_history.user_id` and
 * friends are NOT NULL; there is nowhere to hang a guest's history. Rehearsing
 * still works fully without an account; it just isn't remembered, which is what
 * "Save Progress" in the header has always been offering.
 */

export interface BeatMastery {
  lineId: string
  blockId: string
  beatNumber: number
  text: string
  /** Null when never practised, different from 0, which means she tried and it
   * didn't land. */
  confidenceScore: number | null
  mistakeCount: number
  lastPracticedAt: string | null
}

export interface SessionPlan {
  totalBeats: number
  practisedBeats: number
  /** Worst first, capped server-side. Empty on a first run, which is correct,
   * with no history there is nothing to emphasise. */
  emphasise: BeatMastery[]
}

export interface BeatAttempt {
  lineId: string
  /** Empty when she skipped the beat. That's information, not a missing value. */
  heard: string
}

export interface SavedSession {
  sessionId: string
  beatsScored: number
  beatsMissed: number
  beatsBlank: number
}

export interface FlaggedBeat extends BeatMastery {
  act: string
  scene: string
  /** Empty when she said nothing at all, which is the case most worth showing. */
  whatWasSaid: string
}

/** One of her speeches, with whatever the coach said about it. */
export interface SpeechSummary {
  blockId: string
  /** Scene-local order, the order she spoke them in. */
  firstLineNumber: number
  /** Empty when there was nothing worth saying, which is common and correct. */
  note: string
  /** Per-beat confidence, in beat order. Deliberately not rendered as bands
   * here: the two cuts that turn a number into solid/close/dry are still unset
   * (`docs/OPEN_ITEMS.md` §1a), and inventing them at the render layer is how a
   * guess becomes product behaviour. Carried because the coach agent will want
   * it. */
  confidences: number[]
}

export interface SessionSummary {
  sessionId: string
  playId: string
  act: string
  scene: string
  durationSeconds: number
  /** Null on sessions written before the beats_run column existed. "Not
   * recorded", must not be rendered as 0. */
  beatsRun: number | null
  startedAt: string
  flagged: FlaggedBeat[]
  /** What she set out to run, versus what she got through. Migration 008's
   * block-scoped session, made visible. */
  blocksPlanned: number
  blocksRun: number
  /** Null when she stopped early, a kept rehearsal, not a lost one. */
  completedAt: string | null
  speeches: SpeechSummary[]
}

/**
 * How one finished rehearsal went.
 *
 * `sessionId` is optional and worth passing when it's known: without it the API
 * returns her latest run of this scene, which is right for a refresh but wrong
 * for the moment just after a save that hasn't landed yet.
 *
 * Throws `SESSION_NOT_FOUND` (404) when there is no saved run, a guest, a
 * single-beat drill, or a save that failed. That's an expected state, not an
 * error, and the wrap-up renders it as one.
 */
export function getSessionSummary(
  playId: string,
  act: string,
  scene: string,
  sessionId?: string,
): Promise<SessionSummary> {
  const query = new URLSearchParams({ playId, act, scene })
  if (sessionId) query.set('sessionId', sessionId)
  return apiRequest(`/sessions/summary?${query}`)
}

export function getSessionPlan(
  playId: string,
  act: string,
  scene: string,
  characterId: string,
): Promise<SessionPlan> {
  const query = new URLSearchParams({ playId, act, scene, characterId })
  return apiRequest(`/sessions/plan?${query}`)
}

/**
 * Open a session before she says anything.
 *
 * `docs/coaching-plan.md` §6: the row exists from the start, because per-block
 * coaching needs somewhere to write while the scene is still running. The id it
 * returns is carried on the capture socket, which is what turns a rehearsal into
 * something remembered.
 *
 * 401 for a guest, which is expected rather than exceptional, callers should
 * treat a failure here as "this run won't be remembered" and carry on. Nothing
 * about rehearsing depends on it.
 */
export function startSession(input: {
  playId: string
  act: string
  scene: string
  characterId: string
  /** Defaults to the whole scene. `blocks` is a drill set; a session is a set
   * of blocks and a scene is one kind of set (migration 008). */
  scope?: 'scene' | 'blocks'
  /** Required for `scope: 'blocks'`. */
  blockIds?: string[]
  /** Who chose them. `coach` is what later makes a recommendation checkable
   * against what she actually ran. */
  source?: 'user' | 'coach'
}): Promise<{ sessionId: string }> {
  return apiRequest('/sessions/start', { method: 'POST', body: JSON.stringify(input) })
}

/**
 * Mark the run finished, or leave it abandoned, which is also a real outcome
 * and no longer loses the whole rehearsal.
 *
 * The server decides whether it counts as complete: every block she meant to run
 * has to have all of its beats scored. Calling this does not assert that it went
 * well, only that it stopped.
 */
export function completeSession(
  sessionId: string,
  durationSeconds: number,
): Promise<{ completed: boolean; beatsRun: number; beatsPlanned: number }> {
  return apiRequest(`/sessions/${sessionId}/complete`, {
    method: 'POST',
    body: JSON.stringify({ durationSeconds }),
  })
}

export function saveSession(input: {
  playId: string
  act: string
  scene: string
  durationSeconds: number
  attempts: BeatAttempt[]
}): Promise<SavedSession> {
  return apiRequest('/sessions', { method: 'POST', body: JSON.stringify(input) })
}

/** One beat she still hasn't got, with what she last said instead. */
export interface PromptBookBeat {
  lineId: string
  blockId: string
  act: string
  scene: string
  text: string
  /** Every miss ever, not this run's, `mistake_count` only accumulates. */
  mistakeCount: number
  /** Her latest band, or null when only the deterministic fallback has ever
   * scored it. Null is "not judged", never "not solid". See migration 009. */
  band: 'solid' | 'close' | 'dry' | null
  confidenceScore: number
  /** Empty when she said nothing at all, which is the most useful case to show. */
  whatWasSaid: string
  lastPractisedAt: string | null
}

export interface PromptBook {
  playId: string
  playTitle: string
  characterId: string
  characterName: string
  totalBeats: number
  /** Beats she has attempted at all, how far into the part she is. */
  practisedBeats: number
  /** Beats whose latest band is *solid*. The mastery bar's numerator. */
  solidBeats: number
  needsAnotherLook: PromptBookBeat[]
}

/**
 * Her whole part: how much of it she has, and what she still doesn't.
 *
 * Deliberately not scene-scoped. The wrap-up answers "how did that run go";
 * this answers "where am I with this part", which reads `line_mastery`, keyed
 * (user, line), with no concept of a session at all.
 */
export function getPromptBook(playId: string, characterId: string): Promise<PromptBook> {
  const query = new URLSearchParams({ playId, characterId })
  return apiRequest(`/sessions/prompt-book?${query}`)
}

/** What the coach decided she should do next. */
export interface CoachRecommendation {
  id: string
  /** One or two sentences, quoting a line from her own history. */
  note: string
  /** `drill` runs the named speeches; `scene` runs the whole scene. */
  action: 'drill' | 'scene'
  act: string
  scene: string
  /** The speeches to drill. Empty for a `scene` action. */
  blockIds: string[]
}

/**
 * Run the coach agent over her history and store what it decides.
 *
 * A POST because it is not a read: the agent spends tokens and writes a
 * `coach_recommendation` row it will read back next time. Returns null when
 * there is nothing worth saying, a clean run deserves silence rather than
 * manufactured praise, and also when the agent failed, which the wrap-up
 * treats identically. It never errors: a wrap-up that won't load because the
 * coach had an opinion it couldn't express is worse than one with no coach.
 */
export function runCoach(
  sessionId: string,
  playId: string,
  characterId: string,
): Promise<{ recommendation: CoachRecommendation | null }> {
  return apiRequest(`/sessions/${sessionId}/coach`, {
    method: 'POST',
    body: JSON.stringify({ playId, characterId }),
  })
}

/** The recommendation already made for this session, without re-running the
 * agent, so revisiting a wrap-up costs nothing and says the same thing. */
export function getCoachRecommendation(
  sessionId: string,
  playId: string,
): Promise<{ recommendation: CoachRecommendation | null }> {
  return apiRequest(`/sessions/${sessionId}/coach?playId=${encodeURIComponent(playId)}`)
}
