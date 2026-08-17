/**
 * Play/character/scene/dialogue data is real now (api's features/plays).
 *
 * This module began as a stub layer shaped after the database schema rather
 * than after whatever the screens happened to want, so that swapping in a real
 * fetch needed no caller changes. It worked; the callers never moved. Worth
 * knowing because the shapes here look over-engineered for a mock and weren't.
 *
 * Still mock/localStorage-backed, on purpose: getSelectedRole/selectRole's
 * persistence. Nothing else, the Prompt Book came off fixtures on August 12
 * 2026 and reads `sessions/prompt-book`.
 *
 * The wrap-up used to be here too. It now reads the real session from
 * `sessionClient.getSessionSummary`, `session_history` and `line_mastery` do
 * exist server-side, so a fixture was no longer a stand-in for something
 * missing, it was just a wrong number.
 */
import type { Play, Character } from '../types/domain'
import type { PlaySummary, SceneSummary, DialogueItem } from '../types/views'
import { apiRequest } from './apiClient'
export { blockVerseLines, blockDisplayLines, blockPrompterLines } from './blockText'
export type { PrompterLine } from './blockText'
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
 * is, session_history doesn't exist server-side yet. */
export function getLastScene(playId: string): Promise<LastScene | null> {
  const raw = localStorage.getItem(lastSceneStorageKey(playId))
  if (!raw) return Promise.resolve(null)
  try {
    const parsed: unknown = JSON.parse(raw)
    const { act, scene } = parsed as Partial<LastScene>
    return Promise.resolve(typeof act === 'string' && typeof scene === 'string' ? { act, scene } : null)
  } catch {
    // Hand-edited or half-written value, treat as "no saved place" rather
    // than breaking the play page on load.
    return Promise.resolve(null)
  }
}

export function setLastScene(playId: string, act: string, scene: string): void {
  localStorage.setItem(lastSceneStorageKey(playId), JSON.stringify({ act, scene }))
}

/** The character the user is actually rehearsing as right now, or '' if none selected yet
 * (matches nothing, so isUserLine is false for every line, the picker flow redirects to
 * role-select before this matters in practice). */
function getEffectiveCharacterId(playId: string): string {
  return localStorage.getItem(roleStorageKey(playId)) ?? ''
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

/** One beat, as the API sends it. See docs/beats-and-blocks-plan.md §2. */
interface RawBeat {
  type: 'speech'
  lineId: string
  lineNumber: number
  blockId: string
  beatNumber: number
  text: string
  sourceLines: string[]
  sharesFirstSourceLine: boolean
  isVerse: boolean
  speakerIds: string[]
  speakerNames: string[]
}

type RawDialogueEntry = { type: 'stage'; text: string } | RawBeat

/**
 * Groups beats into blocks, one speaker header, one paragraph, one Polly
 * render.
 *
 * Groups *consecutive* beats sharing a blockId, not every beat with that id: a
 * stage direction between two blocks has to stay between them, and adjacency
 * preserves that for free. Block ids are unique per speech-run, so this can
 * never merge across one.
 */
function toDialogueItems(raw: RawDialogueEntry[], userCharacterId: string): DialogueItem[] {
  const items: DialogueItem[] = []

  for (const entry of raw) {
    if (entry.type === 'stage') {
      items.push({ type: 'stage', text: entry.text })
      continue
    }

    const beat = {
      lineId: entry.lineId,
      beatNumber: entry.beatNumber,
      text: entry.text,
      sourceLines: entry.sourceLines,
      sharesFirstSourceLine: entry.sharesFirstSourceLine,
    }

    const previous = items[items.length - 1]
    if (previous?.type === 'speech' && previous.blockId === entry.blockId) {
      previous.beats.push(beat)
      continue
    }

    // Only the primary speaker's id is carried forward, Polly voices one
    // character per block, and joint-speech blocks are rare (BE_PLAN.md §1a).
    const coSpeakerNames = entry.speakerNames.slice(1)
    items.push({
      type: 'speech',
      blockId: entry.blockId,
      speakerId: entry.speakerIds[0],
      speaker: entry.speakerNames[0],
      coSpeakers: coSpeakerNames.length > 0 ? coSpeakerNames : undefined,
      isVerse: entry.isVerse,
      beats: [beat],
      isUserLine: entry.speakerIds.includes(userCharacterId),
    })
  }

  return items
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

/**
 * Forgets which part she was reading and where she had got to, for every play.
 *
 * Called on sign-out. These two keys look like preferences and are not: they are
 * *her* progress, and leaving them behind means the play page greets whoever
 * opens the app next with "Pick up where you left off — Act IV, Scene VI as
 * Fenton". That is stale for a guest and someone else's business if a second
 * person signs in on the same browser.
 *
 * Prefix-scanned rather than cleared wholesale, because `localStorage` also
 * holds things that genuinely are preferences (`bh:autoScroll`) and Supabase's
 * own session keys. `localStorage.clear()` would take the lot, including the
 * auth library's bookkeeping mid-sign-out.
 *
 * Keys are collected before any are removed: removing during iteration shifts
 * the indices under `key(i)` and silently skips every other match.
 */
export function clearLocalProgress(): void {
  const doomed: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && (key.startsWith('bh:role:') || key.startsWith('bh:lastScene:'))) {
      doomed.push(key)
    }
  }
  doomed.forEach((key) => localStorage.removeItem(key))
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
    // No session_history/line_mastery yet, every scene is legitimately
    // "not started," not a fake fraction. isCurrent likewise always false;
    // the play page's resume card reads the locally-stored last scene instead.
    mastered: 0,
    total: s.totalLines,
    characterLines: s.characterLines,
    isCurrent: false,
  }))
}

export async function getSceneDialogue(playId: string, act: string, scene: string): Promise<DialogueItem[]> {
  const userCharacterId = getEffectiveCharacterId(playId)
  const raw = await apiRequest<RawDialogueEntry[]>(`/plays/${playId}/scenes/${act}/${scene}/dialogue`)
  return toDialogueItems(raw, userCharacterId)
}

/** The Prompt Book's drill on a flagged beat opens that beat's whole *block*.
 * A beat is one thought, and practising it with no run-up into it isn't how the
 * speech is delivered, the API returns the block, the page marks the beat. */
export async function getSingleLineDialogue(playId: string, lineId: string): Promise<DialogueItem[]> {
  const userCharacterId = getEffectiveCharacterId(playId)
  const raw = await apiRequest<RawDialogueEntry[]>(`/plays/${playId}/lines/${lineId}/block`)
  return toDialogueItems(raw, userCharacterId)
}



export { FOCUS_PLAY_ID, MOCK_USER_ID }
