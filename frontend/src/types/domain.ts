/**
 * Mirrors infra/cockroachdb/migrations/001_init_schema.sql field-for-field (camelCased).
 * `act`/`scene` are free-text labels in the schema (e.g. "I", "INDUCTION"), not enums.
 */

export interface Play {
  id: string
  title: string
  sourceUrl?: string
  createdAt: string
}

export interface Character {
  id: string
  playId: string
  name: string
  description?: string
  isSynthetic: boolean
}

export interface Line {
  id: string
  playId: string
  act: string
  actOrder: number
  scene: string
  sceneOrder: number
  sceneDescription?: string
  speechNumber: number
  lineNumber: number
  text: string
  stageDirection?: string
  /** Resolved from line_speakers — a line can have more than one speaker, never assume a single one. */
  speakerIds: string[]
}

export interface StageDirectionEntry {
  id: string
  playId: string
  act: string
  actOrder: number
  scene: string
  sceneOrder: number
  sequence: number
  /** Scene-local line number this direction is interleaved after. No FK to Line. */
  afterLineNumber: number
  text: string
}

export interface User {
  id: string
  name: string
  createdAt: string
}

export interface RoleInProgress {
  id: string
  userId: string
  playId: string
  characterId: string
  createdAt: string
}

export interface SessionHistoryEntry {
  id: string
  userId: string
  playId: string
  act: string
  sceneRange?: string
  startedAt: string
  durationSeconds?: number
}

export interface LineMastery {
  id: string
  userId: string
  lineId: string
  confidenceScore: number
  lastPracticedAt?: string
  mistakeCount: number
}

export interface MistakeLogEntry {
  id: string
  userId: string
  lineId: string
  sessionId: string
  whatWasSaid: string
  createdAt: string
}

export interface Recording {
  id: string
  sessionId: string
  s3Key: string
  createdAt: string
}
