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
  /** Lines the rehearsing character speaks in this scene; 0 if they're not in
   * it. Undefined when the scenes were fetched without a character. */
  characterLines?: number
  isCurrent: boolean
}

/** One thought — the unit the coach scores and `line_mastery` keys on. Not a
 * line of verse. See docs/beats-and-blocks-plan.md §2. */
export interface DialogueBeat {
  lineId: string
  beatNumber: number
  /** The joined text: what Polly speaks and what a transcript is compared
   * against. For a verse block this is *not* what the screen shows — sourceLines
   * is, because a part is memorized by its lineation. */
  text: string
  sourceLines: string[]
  /** sourceLines[0] repeats the previous beat's last line (the beat boundary
   * fell mid-line), so block-level verse display drops it. */
  sharesFirstSourceLine: boolean
}

/** A speech, cut wherever a stage direction falls inside it. One speaker
 * header, one paragraph, one Polly render. */
export interface DialogueBlock {
  type: 'speech'
  blockId: string
  speaker: string
  /** The primary speaker's character id — needed to fetch Polly audio for this
   * block. Playback voices one character per block, so a jointly spoken block
   * still resolves to one voice (BE_PLAN.md §1a). */
  speakerId: string
  coSpeakers?: string[]
  isVerse: boolean
  beats: DialogueBeat[]
  /** True when this is the block the rehearsing user reads — she gets the mic,
   * and no Polly audio is fetched for it. */
  isUserLine: boolean
}

export type DialogueItem = DialogueBlock | { type: 'stage'; text: string }

export interface FlaggedLine {
  lineId: string
  text: string
  act: string
  scene: string
  mistakeCount: number
  lastPracticedAt?: string
}

export interface PromptBookSummary {
  playId: string
  playTitle: string
  characterName: string
  mastered: number
  total: number
  needsAnotherLook: FlaggedLine[]
}
