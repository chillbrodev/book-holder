import type { PlaySummary } from '../../types/views'

export const FOCUS_PLAY_ID = 'merry-wives-of-windsor'

/**
 * The Merry Wives of Windsor is the only fully-built play for the hackathon MVP;
 * the rest render locked to show the product scales beyond one play.
 */
export const MOCK_PLAYS: PlaySummary[] = [
  {
    id: FOCUS_PLAY_ID,
    title: 'The Merry Wives of Windsor',
    createdAt: '2026-06-01T00:00:00Z',
    status: 'focus',
    locked: false,
    favorite: true,
    mastery: { mastered: 71, total: 96 },
  },
  {
    id: 'twelfth-night',
    title: 'Twelfth Night',
    createdAt: '2026-06-01T00:00:00Z',
    status: 'locked',
    locked: true,
    favorite: false,
  },
  {
    id: 'much-ado-about-nothing',
    title: 'Much Ado About Nothing',
    createdAt: '2026-06-01T00:00:00Z',
    status: 'locked',
    locked: true,
    favorite: false,
  },
  {
    id: 'hamlet',
    title: 'Hamlet',
    createdAt: '2026-06-01T00:00:00Z',
    status: 'locked',
    locked: true,
    favorite: false,
  },
]
