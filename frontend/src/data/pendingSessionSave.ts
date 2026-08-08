/**
 * Hands the in-flight session save from the rehearsal page to the wrap-up page.
 *
 * The rehearsal deliberately does not await the save before navigating — a slow
 * or failed write must not trap her on the rehearsal screen after she has
 * finished the scene (see `RehearsalPage.submitSession`). But the wrap-up then
 * mounts and immediately asks the API how the run went, and the write is a
 * serializable transaction with a query per beat. The read wins that race almost
 * every time.
 *
 * Losing it is not a slow page, it is a wrong one: the summary falls back to her
 * most recent saved run of the scene, so a second rehearsal would show the
 * numbers from the first, under the heading "here's how the run went". That is
 * the same class of lie as the fixtures this replaced, and harder to notice.
 *
 * So the promise is parked here and the wrap-up awaits it. The navigation still
 * doesn't block; the waiting happens on the page where a failed save is worth
 * mentioning anyway.
 */
import type { SavedSession } from './sessionClient'

interface PendingSave {
  playId: string
  act: string
  scene: string
  result: Promise<SavedSession>
}

let lastSave: PendingSave | null = null

export function recordSessionSave(save: PendingSave): void {
  lastSave = save
}

/**
 * The save for *this* scene, if one is outstanding.
 *
 * Matched on play/act/scene rather than handed over blindly, because the entry
 * is never cleared: reading it twice is harmless (awaiting a settled promise is
 * free, and React re-runs effects), but navigating to some older wrap-up URL
 * later must not pick up a stale save and read the wrong session back.
 */
export function pendingSessionSave(playId: string, act: string, scene: string): Promise<SavedSession> | null {
  if (!lastSave || lastSave.playId !== playId || lastSave.act !== act || lastSave.scene !== scene) {
    return null
  }
  return lastSave.result
}
