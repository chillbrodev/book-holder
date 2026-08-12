import { apiRequest } from './apiClient'

/**
 * The memory half of the loop: what to lean on before a scene, and what happened
 * after it.
 *
 * Both endpoints require a signed-in user, because `session_history.user_id` and
 * friends are NOT NULL — there is nowhere to hang a guest's history. Rehearsing
 * still works fully without an account; it just isn't remembered, which is what
 * "Save Progress" in the header has always been offering.
 */

export interface BeatMastery {
  lineId: string
  blockId: string
  beatNumber: number
  text: string
  /** Null when never practised — different from 0, which means she tried and it
   * didn't land. */
  confidenceScore: number | null
  mistakeCount: number
  lastPracticedAt: string | null
}

export interface SessionPlan {
  totalBeats: number
  practisedBeats: number
  /** Worst first, capped server-side. Empty on a first run, which is correct —
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
  /** Empty when she said nothing at all — which is the case most worth showing. */
  whatWasSaid: string
}

export interface SessionSummary {
  sessionId: string
  playId: string
  act: string
  scene: string
  durationSeconds: number
  /** Null on sessions written before the beats_run column existed. "Not
   * recorded" — must not be rendered as 0. */
  beatsRun: number | null
  startedAt: string
  flagged: FlaggedBeat[]
}

/**
 * How one finished rehearsal went.
 *
 * `sessionId` is optional and worth passing when it's known: without it the API
 * returns her latest run of this scene, which is right for a refresh but wrong
 * for the moment just after a save that hasn't landed yet.
 *
 * Throws `SESSION_NOT_FOUND` (404) when there is no saved run — a guest, a
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
 * 401 for a guest, which is expected rather than exceptional — callers should
 * treat a failure here as "this run won't be remembered" and carry on. Nothing
 * about rehearsing depends on it.
 */
export function startSession(input: {
  playId: string
  act: string
  scene: string
  characterId: string
  /** Defaults to the whole scene. `blocks` is a drill set — a session is a set
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
 * Mark the run finished — or leave it abandoned, which is also a real outcome
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
