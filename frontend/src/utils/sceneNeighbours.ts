import type { SceneSummary } from '../types/views'

/**
 * Which scene comes next, and which scene comes next *for her*.
 *
 * Two different questions, and the difference is not cosmetic. Mistress Ford
 * appears in 6 of Merry Wives' 23 scenes, so the scene that literally follows the
 * one she just rehearsed is usually one she has no lines in — four times out of
 * five. Offering only the play-order neighbour would send her somewhere with
 * nothing to say; offering only her own would hide the play's shape from someone
 * reading a scene for context, or rehearsing a part she hasn't picked yet.
 *
 * So both are computed, and the caller shows whichever are distinct — see
 * `describeNeighbours`.
 */

export interface SceneRef {
  act: string
  scene: string
  actOrder: number
  sceneOrder: number
  /** Beats her character speaks here. Undefined when the scenes were fetched
   * without a character, which is why "is she in it" is a helper and not a
   * `> 0` check scattered at each call site. */
  characterLines?: number
}

export interface SceneNeighbours {
  previousInPlay: SceneRef | null
  nextInPlay: SceneRef | null
  /** Nearest scene in that direction that she actually speaks in. Null at the
   * ends of her part — which is a meaningful signal, not a gap: no `nextForRole`
   * means she has been through the whole role. */
  previousForRole: SceneRef | null
  nextForRole: SceneRef | null
}

/** Play order. `act`/`scene` are Roman-numeral strings ("II", "iii"), so they
 * cannot be sorted as text — the numeric *Order columns exist precisely because
 * "X" sorts before "II" alphabetically. */
function byPlayOrder(a: SceneRef, b: SceneRef): number {
  return a.actOrder - b.actOrder || a.sceneOrder - b.sceneOrder
}

function speaksIn(scene: SceneRef): boolean {
  // Undefined means "we didn't ask about a character", which is not the same as
  // "she has no lines". Treated as not-hers so the role-aware controls simply
  // don't appear rather than appearing and lying.
  return (scene.characterLines ?? 0) > 0
}

export function findSceneNeighbours(scenes: SceneSummary[], act: string, scene: string): SceneNeighbours {
  const ordered = [...scenes].sort(byPlayOrder)
  const index = ordered.findIndex((s) => s.act === act && s.scene === scene)

  // The current scene isn't in the list — a hand-typed URL, or a scene from
  // another play. Everything null, so the caller renders no navigation at all
  // rather than guessing a direction from nothing.
  if (index === -1) {
    return { previousInPlay: null, nextInPlay: null, previousForRole: null, nextForRole: null }
  }

  const search = (from: number, step: number, predicate: (s: SceneRef) => boolean): SceneRef | null => {
    for (let i = from; i >= 0 && i < ordered.length; i += step) {
      if (predicate(ordered[i])) return ordered[i]
    }
    return null
  }

  return {
    previousInPlay: search(index - 1, -1, () => true),
    nextInPlay: search(index + 1, 1, () => true),
    previousForRole: search(index - 1, -1, speaksIn),
    nextForRole: search(index + 1, 1, speaksIn),
  }
}

export function isSameScene(a: SceneRef | null, b: SceneRef | null): boolean {
  if (!a || !b) return false
  return a.actOrder === b.actOrder && a.sceneOrder === b.sceneOrder
}

/** "II.i" — how a scene is named to her throughout the app. */
export function sceneLabel(scene: SceneRef): string {
  return `${scene.act}.${scene.scene}`
}

export interface NeighbourRow {
  previous: SceneRef | null
  next: SceneRef | null
}

/**
 * Collapses the four neighbours into the rows worth rendering.
 *
 * `roleRow` is null when it would say the same thing as `playRow` — either
 * because the adjacent scenes happen to be ones she's in, or because no character
 * was selected so there is no "her scenes" answer to give. Two controls pointing
 * at the same scene is noise, so the caller shows labels only when both rows are
 * present and therefore genuinely different.
 */
export function describeNeighbours(neighbours: SceneNeighbours): {
  playRow: NeighbourRow | null
  roleRow: NeighbourRow | null
} {
  const { previousInPlay, nextInPlay, previousForRole, nextForRole } = neighbours

  const row = (previous: SceneRef | null, next: SceneRef | null): NeighbourRow | null =>
    previous || next ? { previous, next } : null

  /** Two answers agree when they name the same scene, or when neither exists. */
  const agree = (a: SceneRef | null, b: SceneRef | null) => isSameScene(a, b) || (a === null && b === null)

  const roleRow = agree(previousInPlay, previousForRole) && agree(nextInPlay, nextForRole)
    ? null
    : row(previousForRole, nextForRole)

  return { playRow: row(previousInPlay, nextInPlay), roleRow }
}
