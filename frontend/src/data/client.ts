/**
 * Stub "API" — one async function per data need, matching the shape a real fetch-based
 * implementation will eventually have so callers don't change when it's swapped in.
 */
import type { Play, Character } from '../types/domain'
import type { PlaySummary, SceneSummary, DialogueEntry, FlaggedLine, WrapUpSummary, PromptBookSummary } from '../types/views'
import { delay } from './latency'
import { MOCK_PLAYS, FOCUS_PLAY_ID } from './mock/plays'
import { MOCK_CHARACTERS, USER_CHARACTER_ID } from './mock/characters'
import { ACT_2_SCENE_1_LINES } from './mock/lines'
import { ACT_2_SCENE_1_STAGE_DIRECTIONS } from './mock/stageDirections'
import { MOCK_SCENES_SUMMARY } from './mock/scenesSummary'
import { MOCK_FLAGGED_LINES, WRAP_UP_FLAGGED_LINE_IDS, findLineById } from './mock/promptBook'
import { MOCK_USER_ID } from './mock/roles'

function roleStorageKey(playId: string): string {
  return `bh:role:${playId}`
}

function characterName(characterId: string): string {
  return MOCK_CHARACTERS.find((c) => c.id === characterId)?.name ?? characterId
}

/** The character the user is actually rehearsing as right now, falling back to the default seed role. */
function getEffectiveCharacterId(playId: string): string {
  return localStorage.getItem(roleStorageKey(playId)) ?? USER_CHARACTER_ID
}

function buildFlaggedLine(entry: { lineId: string; mistakeCount: number; lastPracticedAt: string }): FlaggedLine | undefined {
  const line = findLineById(entry.lineId)
  if (!line) return undefined
  return {
    lineId: line.id,
    text: line.text,
    act: line.act,
    scene: line.scene,
    mistakeCount: entry.mistakeCount,
    lastPracticedAt: entry.lastPracticedAt,
  }
}

interface SortableDialogueEntry {
  sortKey: number
  sortTiebreak: number
  entry: DialogueEntry
}

/** Builds the ordered dialogue stream for Act II Scene 1 by interleaving lines and stage directions. */
function buildSceneDialogue(playId: string, act: string, scene: string): DialogueEntry[] {
  if (act !== 'II' || scene !== '1') return []

  const userCharacterId = getEffectiveCharacterId(playId)
  const sortable: SortableDialogueEntry[] = []

  for (const line of ACT_2_SCENE_1_LINES) {
    const [primarySpeakerId, ...coSpeakerIds] = line.speakerIds
    sortable.push({
      sortKey: line.lineNumber,
      sortTiebreak: 1,
      entry: {
        type: 'speech',
        lineId: line.id,
        speaker: characterName(primarySpeakerId),
        coSpeakers: coSpeakerIds.length > 0 ? coSpeakerIds.map(characterName) : undefined,
        text: line.text,
        isUserLine: line.speakerIds.includes(userCharacterId),
      },
    })
  }

  for (const direction of ACT_2_SCENE_1_STAGE_DIRECTIONS) {
    sortable.push({
      sortKey: direction.afterLineNumber,
      sortTiebreak: 0,
      entry: {
        type: 'stage',
        text: direction.text,
        isUserLine: false,
      },
    })
  }

  sortable.sort((a, b) => a.sortKey - b.sortKey || a.sortTiebreak - b.sortTiebreak)

  return sortable.map((item) => item.entry)
}

export function getPlays(): Promise<PlaySummary[]> {
  return delay(MOCK_PLAYS)
}

export function getPlay(playId: string): Promise<Play | undefined> {
  const play = MOCK_PLAYS.find((p) => p.id === playId)
  return delay(play ? { id: play.id, title: play.title, sourceUrl: play.sourceUrl, createdAt: play.createdAt } : undefined)
}

export function getCharacters(playId: string): Promise<Character[]> {
  return delay(MOCK_CHARACTERS.filter((c) => c.playId === playId))
}

export function getSelectedRole(playId: string): Promise<Character | null> {
  const characterId = localStorage.getItem(roleStorageKey(playId))
  const character = characterId ? (MOCK_CHARACTERS.find((c) => c.id === characterId) ?? null) : null
  return delay(character)
}

export function selectRole(playId: string, characterId: string): Promise<void> {
  localStorage.setItem(roleStorageKey(playId), characterId)
  return delay(undefined)
}

export function getScenesSummary(_playId: string): Promise<SceneSummary[]> {
  return delay(MOCK_SCENES_SUMMARY)
}

export function getSceneDialogue(playId: string, act: string, scene: string): Promise<DialogueEntry[]> {
  return delay(buildSceneDialogue(playId, act, scene))
}

export function getSingleLineDialogue(playId: string, lineId: string): Promise<DialogueEntry[]> {
  const line = findLineById(lineId)
  if (!line) return delay([])
  const userCharacterId = getEffectiveCharacterId(playId)
  const [primarySpeakerId, ...coSpeakerIds] = line.speakerIds
  const entry: DialogueEntry = {
    type: 'speech',
    lineId: line.id,
    speaker: characterName(primarySpeakerId),
    coSpeakers: coSpeakerIds.length > 0 ? coSpeakerIds.map(characterName) : undefined,
    text: line.text,
    isUserLine: line.speakerIds.includes(userCharacterId),
  }
  return delay([entry])
}

export function getWrapUpSummary(playId: string, act: string, scene: string): Promise<WrapUpSummary> {
  const flagged = WRAP_UP_FLAGGED_LINE_IDS.map((lineId) => MOCK_FLAGGED_LINES.find((f) => f.lineId === lineId))
    .filter((entry): entry is (typeof MOCK_FLAGGED_LINES)[number] => entry !== undefined)
    .map(buildFlaggedLine)
    .filter((entry): entry is FlaggedLine => entry !== undefined)

  return delay({
    playId,
    act,
    scene,
    durationSeconds: 360,
    linesRun: ACT_2_SCENE_1_LINES.length,
    flagged,
  })
}

export function getPromptBookSummary(playId: string): Promise<PromptBookSummary> {
  const play = MOCK_PLAYS.find((p) => p.id === playId)
  const needsAnotherLook = MOCK_FLAGGED_LINES.map(buildFlaggedLine).filter((entry): entry is FlaggedLine => entry !== undefined)

  return delay({
    playId,
    playTitle: play?.title ?? '',
    characterName: characterName(getEffectiveCharacterId(playId)),
    mastered: play?.mastery?.mastered ?? 0,
    total: play?.mastery?.total ?? 0,
    needsAnotherLook,
  })
}

export { FOCUS_PLAY_ID, MOCK_USER_ID }
