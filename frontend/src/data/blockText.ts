/**
 * Turning a block's beats into rows on a screen.
 *
 * Pure, and deliberately in its own module rather than in `client.ts`: this is
 * display mapping, it fetches nothing, and living next to the fetch client meant
 * it could not be exercised without pulling in `apiClient` -> `supabaseClient`
 * and therefore a browser's `import.meta.env`. A rule about where a beat breaks
 * should be checkable on its own.
 */
import type { DialogueBlock } from '../types/views'

/** A block's verse lines, each exactly once, what a verse display renders.
 *
 * A beat boundary usually falls mid-line, so that line is the last entry of one
 * beat and the first of the next. `sharesFirstSourceLine` marks exactly that,
 * rather than comparing the text: a song refrain can legitimately repeat an
 * identical line inside one block, and equality would swallow the repeat. */
export function blockVerseLines(block: DialogueBlock): string[] {
  return block.beats.flatMap((beat) =>
    beat.sharesFirstSourceLine ? beat.sourceLines.slice(1) : beat.sourceLines,
  )
}

/** What the screen shows for a block: verse keeps its lineation, prose flows.
 * Prose "lines" are only Moby's fixed-width typesetting and would look
 * arbitrary at any width but the one they were set for. */
export function blockDisplayLines(block: DialogueBlock): string[] {
  return block.isVerse ? blockVerseLines(block) : [block.beats.map((b) => b.text).join(' ')]
}

/** One row of the teleprompter, and the span of beats it carries. */
export interface PrompterLine {
  text: string
  /**
   * Indices into `block.beats` — inclusive, and a *range* rather than one
   * index, because one line of verse can carry more than one thought.
   *
   * In Fenton's IV.vi speech the line "I'll show you here at large. Hark, good
   * mine host." ends beat 3 and *contains the whole of* beat 4. Attributing
   * that row to a single beat means that when the mic reports beat 4, the
   * prompter has nothing to light: the words she is saying sit in a row already
   * dimmed as said. 14 beats in this corpus are like that.
   *
   * So a row is current whenever the live beat falls anywhere in its span.
   */
  beatStart: number
  beatEnd: number
}

/**
 * The block, cut into rows the prompter can light one beat at a time.
 *
 * This is `blockDisplayLines` with the beat attribution kept rather than
 * flattened away, and keeping it is the whole point: the mic reports a beat
 * index, so without this the screen can only highlight a whole speech or
 * nothing.
 *
 * Verse rows are `sourceLines`, because a part is memorized by its lineation
 * and a 45-line speech reflowed into a paragraph is precisely how you lose your
 * place. Prose gets one row per beat instead — its source lines are only Moby's
 * fixed-width typesetting, so a beat (one thought) is the smallest honest unit
 * to break on.
 *
 * `sharesFirstSourceLine` marks a beat whose first source line is the previous
 * beat's last — the boundary fell mid-line. That line is not repeated as a new
 * row (which is what `blockVerseLines` avoids too); instead the row already on
 * screen has its span *extended* to cover the incoming beat. That is what keeps
 * a beat living entirely inside a shared line visible and lightable.
 */
export function blockPrompterLines(block: DialogueBlock): PrompterLine[] {
  const rows: PrompterLine[] = []

  block.beats.forEach((beat, beatIndex) => {
    // Prose breaks per beat, not per source line: its lineation is only Moby's
    // fixed-width typesetting, so a thought is the smallest honest unit.
    if (!block.isVerse) {
      rows.push({ text: beat.text, beatStart: beatIndex, beatEnd: beatIndex })
      return
    }

    beat.sourceLines.forEach((text, i) => {
      const previous = rows[rows.length - 1]
      if (i === 0 && beat.sharesFirstSourceLine && previous) {
        // Already on screen as the previous beat's last row. Widen it rather
        // than printing the line twice.
        previous.beatEnd = beatIndex
        return
      }
      rows.push({ text, beatStart: beatIndex, beatEnd: beatIndex })
    })
  })

  return rows
}
