/**
 * Play/character/scene/dialogue data is real now (api's features/plays) —
 * see FE-Stub-Plan.md's original stub shapes, which this was deliberately
 * built to match so swapping in a real fetch required no caller changes.
 *
 * Still mock/localStorage-backed, on purpose (session_history/line_mastery
 * don't exist server-side yet): getSelectedRole/selectRole's persistence,
 * getWrapUpSummary, getPromptBookSummary.
 */
import type { Play, Character } from '../types/domain'
import type { PlaySummary, SceneSummary, DialogueEntry, FlaggedLine, WrapUpSummary, PromptBookSummary } from '../types/views'
import { apiRequest } from './apiClient'
import { ACT_2_SCENE_1_LINES } from './mock/lines'
import { MOCK_FLAGGED_LINES, WRAP_UP_FLAGGED_LINE_IDS, findLineById } from './mock/promptBook'
import { MOCK_USER_ID } from './mock/roles'

const FOCUS_PLAY_ID = 'merry-wives-of-windsor'

function roleStorageKey(playId: string): string {
  return `bh:role:${playId}`
}

function lastSceneStorageKey(playId: string): string {
  return `bh:lastScene:${playId}`
}

export interface LastScene {
  act: string
  scene: string
}

/** Where she stopped last, so the play page can offer to resume rather than
 * making her find her place again. localStorage for the same reason the role
 * is — session_history doesn't exist server-side yet. */
export function getLastScene(playId: string): Promise<LastScene | null> {
  const raw = localStorage.getItem(lastSceneStorageKey(playId))
  if (!raw) return Promise.resolve(null)
  try {
    const parsed: unknown = JSON.parse(raw)
    const { act, scene } = parsed as Partial<LastScene>
    return Promise.resolve(typeof act === 'string' && typeof scene === 'string' ? { act, scene } : null)
  } catch {
    // Hand-edited or half-written value — treat as "no saved place" rather
    // than breaking the play page on load.
    return Promise.resolve(null)
  }
}

export function setLastScene(playId: string, act: string, scene: string): void {
  localStorage.setItem(lastSceneStorageKey(playId), JSON.stringify({ act, scene }))
}

/** The character the user is actually rehearsing as right now, or '' if none selected yet
 * (matches nothing, so isUserLine is false for every line — the picker flow redirects to
 * role-select before this matters in practice). */
function getEffectiveCharacterId(playId: string): string {
  return localStorage.getItem(roleStorageKey(playId)) ?? ''
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

interface RawPlay {
  id: string
  title: string
  sourceUrl: string | null
  createdAt: string
}

interface RawSceneSummary {
  act: string
  actOrder: number
  scene: string
  sceneOrder: number
  description: string | null
  totalLines: number
  characterLines: number
}

type RawDialogueEntry =
  | { type: 'stage'; text: string }
  | { type: 'speech'; lineId: string; lineNumber: number; text: string; speakerIds: string[]; speakerNames: string[] }

function toDialogueEntry(raw: RawDialogueEntry, userCharacterId: string): DialogueEntry {
  if (raw.type === 'stage') {
    return { type: 'stage', text: raw.text, isUserLine: false }
  }
  // Only the primary speaker's id is carried forward — Polly playback voices
  // one character per line, and joint-speech lines are rare (BE_PLAN.md §1a).
  const coSpeakerNames = raw.speakerNames.slice(1)
  return {
    type: 'speech',
    lineId: raw.lineId,
    speakerId: raw.speakerIds[0],
    speaker: raw.speakerNames[0],
    coSpeakers: coSpeakerNames.length > 0 ? coSpeakerNames : undefined,
    text: raw.text,
    isUserLine: raw.speakerIds.includes(userCharacterId),
  }
}

export async function getPlays(): Promise<PlaySummary[]> {
  const plays = await apiRequest<RawPlay[]>('/plays')
  return plays.map((play) => ({
    id: play.id,
    title: play.title,
    sourceUrl: play.sourceUrl ?? undefined,
    createdAt: play.createdAt,
    status: 'focus',
    locked: false,
    favorite: true,
  }))
}

export async function getPlay(playId: string): Promise<Play | undefined> {
  const plays = await apiRequest<RawPlay[]>('/plays')
  const play = plays.find((p) => p.id === playId)
  return play ? { id: play.id, title: play.title, sourceUrl: play.sourceUrl ?? undefined, createdAt: play.createdAt } : undefined
}

export function getCharacters(playId: string): Promise<Character[]> {
  return apiRequest(`/plays/${playId}/characters`)
}

export async function getSelectedRole(playId: string): Promise<Character | null> {
  const characterId = localStorage.getItem(roleStorageKey(playId))
  if (!characterId) return null
  const characters = await getCharacters(playId)
  return characters.find((c) => c.id === characterId) ?? null
}

export function selectRole(playId: string, characterId: string): Promise<void> {
  localStorage.setItem(roleStorageKey(playId), characterId)
  return Promise.resolve()
}

/** `characterId` asks the API for that character's per-scene line counts, so
 * the picker can lead with the scenes their part is actually in. */
export async function getScenesSummary(playId: string, characterId?: string): Promise<SceneSummary[]> {
  const query = characterId ? `?characterId=${characterId}` : ''
  const scenes = await apiRequest<RawSceneSummary[]>(`/plays/${playId}/scenes${query}`)
  return scenes.map((s) => ({
    act: s.act,
    actOrder: s.actOrder,
    scene: s.scene,
    sceneOrder: s.sceneOrder,
    title: `Scene ${s.scene}`,
    description: s.description ?? undefined,
    // No session_history/line_mastery yet — every scene is legitimately
    // "not started," not a fake fraction. isCurrent likewise always false;
    // the play page's resume card reads the locally-stored last scene instead.
    mastered: 0,
    total: s.totalLines,
    characterLines: s.characterLines,
    isCurrent: false,
  }))
}

export async function getSceneDialogue(playId: string, act: string, scene: string): Promise<DialogueEntry[]> {
  const userCharacterId = getEffectiveCharacterId(playId)
  const raw = await apiRequest<RawDialogueEntry[]>(`/plays/${playId}/scenes/${act}/${scene}/dialogue`)
  return raw.map((entry) => toDialogueEntry(entry, userCharacterId))
}

export async function getSingleLineDialogue(playId: string, lineId: string): Promise<DialogueEntry[]> {
  const userCharacterId = getEffectiveCharacterId(playId)
  const raw = await apiRequest<RawDialogueEntry>(`/plays/${playId}/lines/${lineId}`)
  return [toDialogueEntry(raw, userCharacterId)]
}

export function getWrapUpSummary(playId: string, act: string, scene: string): Promise<WrapUpSummary> {
  const flagged = WRAP_UP_FLAGGED_LINE_IDS.map((lineId) => MOCK_FLAGGED_LINES.find((f) => f.lineId === lineId))
    .filter((entry): entry is (typeof MOCK_FLAGGED_LINES)[number] => entry !== undefined)
    .map(buildFlaggedLine)
    .filter((entry): entry is FlaggedLine => entry !== undefined)

  return Promise.resolve({
    playId,
    act,
    scene,
    durationSeconds: 360,
    linesRun: ACT_2_SCENE_1_LINES.length,
    flagged,
  })
}

export function getPromptBookSummary(playId: string): Promise<PromptBookSummary> {
  const needsAnotherLook = MOCK_FLAGGED_LINES.map(buildFlaggedLine).filter((entry): entry is FlaggedLine => entry !== undefined)

  return Promise.resolve({
    playId,
    playTitle: 'The Merry Wives of Windsor',
    characterName: 'Mistress Ford',
    mastered: 71,
    total: 96,
    needsAnotherLook,
  })
}

export { FOCUS_PLAY_ID, MOCK_USER_ID }
