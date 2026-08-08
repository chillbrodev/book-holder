import { ACT_2_SCENE_1_LINES } from './lines'

function lineId(lineNumber: number): string {
  return `merry-wives-of-windsor-II-1-${lineNumber}`
}

/**
 * Synthetic mistake/practice history for a handful of Mistress Ford's lines, sorted by
 * mistake count descending — this is what "Needs another look" and the scene wrap-up draw from.
 */
export const MOCK_FLAGGED_LINES = [
  { lineId: lineId(12), mistakeCount: 7, lastPracticedAt: '2026-07-22T00:00:00Z' },
  { lineId: lineId(6), mistakeCount: 5, lastPracticedAt: '2026-07-22T00:00:00Z' },
  { lineId: lineId(10), mistakeCount: 2, lastPracticedAt: '2026-07-17T00:00:00Z' },
]

export function findLineById(lineId: string) {
  return ACT_2_SCENE_1_LINES.find((line) => line.id === lineId)
}
