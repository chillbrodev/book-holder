/**
 * Loads a scene exported by `play-importer`'s export:fixture in the exact shape
 * the API will return once migration 004 lands — real beat data, no database,
 * no Polly, no spend.
 *
 * Temporary: delete this once `getSceneDialogue` returns blockId/sourceLines
 * for real. Kept separate from client.ts rather than threaded through it so
 * there's no fixture branch left behind in the live data path.
 */
import type { DialogueBlock, DialogueItem } from '../types/views'
import merryWivesIiI from './fixtures/merry-wives-ii-i.json'
import richardIiIiiIi from './fixtures/richard-ii-iii-ii.json'

interface FixtureSpeech {
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
type FixtureEntry = FixtureSpeech | { type: 'stage'; text: string }

interface Fixture {
  play: { id: string; title: string }
  act: string
  scene: string
  description: string | null
  characters: Array<{ id: string; name: string }>
  entries: FixtureEntry[]
}

export const FIXTURES: Record<string, Fixture> = {
  'merry-wives-ii-i': merryWivesIiI as Fixture,
  'richard-ii-iii-ii': richardIiIiiIi as Fixture,
}

/**
 * Groups consecutive beats sharing a blockId into one block.
 *
 * Consecutive, not "all beats with this blockId" — a stage direction between
 * two blocks must stay between them, and adjacency is what preserves that for
 * free. Block ids are unique per speech-run, so this can't merge across one.
 */
export function toDialogueItems(fixture: Fixture, userCharacterId: string | null): DialogueItem[] {
  const items: DialogueItem[] = []

  for (const entry of fixture.entries) {
    if (entry.type === 'stage') {
      items.push({ type: 'stage', text: entry.text })
      continue
    }

    const previous = items[items.length - 1]
    const beat = {
      lineId: entry.lineId,
      beatNumber: entry.beatNumber,
      text: entry.text,
      sourceLines: entry.sourceLines,
      sharesFirstSourceLine: entry.sharesFirstSourceLine,
    }

    if (previous?.type === 'speech' && previous.blockId === entry.blockId) {
      previous.beats.push(beat)
      continue
    }

    // Only the primary speaker is carried for playback — a jointly spoken
    // block still needs one voice (BE_PLAN.md §1a).
    const coSpeakers = entry.speakerNames.slice(1)
    items.push({
      type: 'speech',
      blockId: entry.blockId,
      speaker: entry.speakerNames[0],
      speakerId: entry.speakerIds[0],
      coSpeakers: coSpeakers.length > 0 ? coSpeakers : undefined,
      isVerse: entry.isVerse,
      beats: [beat],
      isUserLine: userCharacterId !== null && entry.speakerIds.includes(userCharacterId),
    })
  }

  return items
}

/** A block's verse lines, each exactly once, in order — the same rule as the
 * importer's blocks.ts. A beat boundary usually falls mid-line, so that line is
 * the last entry of one beat and the first of the next; the flag marks it
 * rather than comparing text, because a song refrain can legitimately repeat an
 * identical line inside one block. */
export function blockVerseLines(block: DialogueBlock): string[] {
  return block.beats.flatMap((beat) =>
    beat.sharesFirstSourceLine ? beat.sourceLines.slice(1) : beat.sourceLines,
  )
}

/** What Polly will be handed for this block, and what a transcript gets
 * compared against. */
export function blockText(block: DialogueBlock): string {
  return block.beats.map((beat) => beat.text).join(' ')
}
