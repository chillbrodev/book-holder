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

export function getSessionPlan(
  playId: string,
  act: string,
  scene: string,
  characterId: string,
): Promise<SessionPlan> {
  const query = new URLSearchParams({ playId, act, scene, characterId })
  return apiRequest(`/sessions/plan?${query}`)
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
