import { useEffect, useRef } from 'react'
import { blockPrompterLines } from '../../data/client'
import type { DialogueBlock } from '../../types/views'
import { cx } from '../../utils/cx'
import styles from './Teleprompter.module.css'

export interface TeleprompterProps {
  block: DialogueBlock
  /** The beat the mic believes she is on. Drives both the highlight and the
   * scroll; nothing else in here knows the mic exists. */
  beatIndex: number
  /**
   * Hold the words back, drawing only the shape of the speech.
   *
   * All of it or none of it. A per-beat reveal was the previous design and it
   * was wrong twice over: it needed a tap per thought, and the thing it was
   * protecting against — handing over a sixteen-beat speech all at once — was
   * only ever a problem because the speech arrived as an undifferentiated wall.
   * With the current beat lit and the rest receding, showing the whole thing is
   * a prompter, not the answer key.
   */
  masked?: boolean
  /** Set by the card that owns the layout — the prompter does not decide how
   * much room it gets. */
  className?: string
  /** Frozen after the mic has stopped: the speech stops following anything and
   * stays where she left it, so a glance back at what she just did isn't a
   * moving target. */
  frozen?: boolean
}

/**
 * Her speech, as a prompter that follows her.
 *
 * The problem this exists for: a block is the unit of display, and that quietly
 * assumed a block fits on a screen. Fenton's IV.vi speech is 11 beats over 45
 * lines of verse — taller than any laptop viewport. Rendered in page flow it
 * pushed the mic controls off the bottom, and page-level auto-scroll (which
 * aligns the *end* of the active block) then pushed the line she was reading off
 * the top. She scrolled up and down through a reflowing wall of text, lost her
 * place, and repeated words. That was the whole report, and every part of it
 * follows from an unbounded block.
 *
 * So the speech gets a bounded pane that scrolls *itself*, from the live beat
 * cursor the capture socket already streams and which until now only fed a
 * progress dial. Bounding the height is also what pins the controls: they sit
 * under a pane that cannot grow, so they never move, and no sticky positioning
 * is needed to achieve it.
 *
 * Three states per row, and they are deliberately not three shades of the same
 * idea: *said* recedes, *now* is lit and marked with a rule, *ahead* stays at
 * full readability. Dimming what is coming would be the one thing an actor
 * cannot afford — verse is read several lines ahead of where it is spoken.
 */
export function Teleprompter({ block, beatIndex, masked = false, frozen = false, className }: TeleprompterProps) {
  const paneRef = useRef<HTMLDivElement>(null)
  const currentRef = useRef<HTMLParagraphElement>(null)

  const rows = blockPrompterLines(block)
  // The scroll anchor: the first row carrying the live beat. Resolved once, up
  // here, rather than during the map — a beat spanning several rows would
  // otherwise hand the ref to each of them in turn and the last would win,
  // parking the *bottom* of the thought at the reading height instead of its
  // first line.
  const anchorIndex = rows.findIndex((row) => beatIndex >= row.beatStart && beatIndex <= row.beatEnd)

  useEffect(() => {
    if (frozen) return
    const pane = paneRef.current
    const current = currentRef.current
    if (!pane || !current) return

    // Scroll the *pane*, never the page. `scrollIntoView` would walk up to the
    // document scroller and drag the whole rehearsal with it, which is the
    // behaviour being replaced here.
    //
    // The lit line is parked a third of the way down rather than centred or at
    // the top: high enough that several unspoken lines stay visible below it —
    // verse is read ahead of where it is spoken — and low enough that the line
    // just said is still there to glance back at.
    const target = current.offsetTop - pane.clientHeight / 3
    pane.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
    // `masked` is a dependency because revealing the words changes every row's
    // height — a masked row is one line, a real line of verse can wrap to two —
    // so the offset computed while the speech was hidden points somewhere else
    // the moment it is shown. Without it, tapping "Show lines" left the pane
    // parked mid-speech with her actual place off screen.
  }, [beatIndex, frozen, masked, block.blockId])

  return (
    <div className={cx(styles.pane, className)} ref={paneRef}>
      {rows.map((row, i) => {
        const isCurrent = beatIndex >= row.beatStart && beatIndex <= row.beatEnd
        const isSaid = row.beatEnd < beatIndex
        // The shape is still drawn at full size, so asking for the words fills
        // them in where they already were rather than growing the speech and
        // moving everything under her — which is what the old reveal did on
        // every tap.
        const isHidden = masked

        return (
          <p
            key={i}
            ref={i === anchorIndex ? currentRef : undefined}
            data-beat={row.beatStart}
            className={cx(
              styles.row,
              block.isVerse ? styles.verse : styles.prose,
              isSaid && styles.said,
              isCurrent && styles.now,
              isHidden && styles.hidden,
            )}
          >
            {isHidden ? <span className={styles.mask} aria-hidden="true" /> : row.text}
          </p>
        )
      })}
    </div>
  )
}
