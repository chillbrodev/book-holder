/**
 * UI-shaped types the stub (and later, real) API returns — what pages actually consume,
 * as opposed to the 1:1 schema shapes in domain.ts.
 */
import type { Play } from './domain'

export type PlayStatus = 'focus' | 'favorite' | 'inProgress' | 'neutral' | 'locked'

export interface PlaySummary extends Play {
  status: PlayStatus
  locked: boolean
  favorite: boolean
  mastery?: { mastered: number; total: number }
}

export interface SceneSummary {
  act: string
  actOrder: number
  scene: string
  sceneOrder: number
  title: string
  description?: string
  mastered: number
  total: number
  isCurrent: boolean
}

export interface DialogueEntry {
  type: 'stage' | 'speech'
  lineId?: string
  speaker?: string
  coSpeakers?: string[]
  text: string
  /** Generalizes the prototype's `isFord` — true when this is the line the rehearsing user reads. */
  isUserLine: boolean
}

export interface FlaggedLine {
  lineId: string
  text: string
  act: string
  scene: string
  mistakeCount: number
  lastPracticedAt?: string
}

export interface WrapUpSummary {
  playId: string
  act: string
  scene: string
  durationSeconds: number
  linesRun: number
  flagged: FlaggedLine[]
}

export interface PromptBookSummary {
  playId: string
  playTitle: string
  characterName: string
  mastered: number
  total: number
  needsAnotherLook: FlaggedLine[]
}
