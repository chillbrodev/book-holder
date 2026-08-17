import { useEffect, useRef } from 'react'
import type { MicState } from '../../hooks/useMicCapture'
import styles from './HeardSoFar.module.css'

export interface HeardSoFarProps {
  micState: MicState
  transcript: string
}

/**
 * Her own words, back to her, as she says them.
 *
 * Not the same thing as CaptureDebugInfo, which this deliberately does not
 * replace: that one is 11px monospace with mic state and beat counters, it is
 * for whoever is debugging the cursor, and it is dropped from production
 * builds. This is for the actor, in production, and is held to §8 of the style
 * guide, sans, at the 16px body floor, muted rather than faint.
 *
 * Showing partials is explicitly sanctioned: `CaptureEvent.isPartial` is
 * documented "the UI may show it; nothing may score it", and capture-plan.md §7
 * puts partials with the cursor and the UI. So this is display of provisional
 * text by design, not a shortcut around the scoring rule.
 *
 * What it deliberately is *not*: a prompt. It renders what she said, never what
 * the text says, so it stays honest when "Your lines" is hidden, seeing your
 * own words is feedback, seeing the line would be the app rehearsing for you.
 * That distinction is the whole reason this can be shown unconditionally.
 *
 * The transcript is *not* dimmed while a partial is in flight, though the debug
 * component has styling for exactly that. `isPartial` describes the whole event
 * rather than the tail that might still change, so dimming would flash the
 * entire line on every partial, roughly twice a second, which reads as a fault
 * rather than as provisionality.
 */
export function HeardSoFar({ micState, transcript }: HeardSoFarProps) {
  const textRef = useRef<HTMLParagraphElement>(null)

  // Held at the tail as the transcript grows. The box is bounded (see the CSS),
  // so without this a long speech would leave her reading its opening words
  // while she is forty lines further on — a readout that stops tracking her is
  // worse than none, because it looks like the mic has stalled.
  useEffect(() => {
    const el = textRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [transcript])

  // Absent rather than empty before she has said anything: an empty quoted box
  // under her line looks like the mic has failed, which is the one thing this
  // screen must never imply falsely (style guide §9).
  if (!transcript) return null
  // `captured` keeps it on screen, the last thing she said stays readable while
  // the scene moves on, which is what makes it feedback rather than a live
  // readout that vanishes at the moment it becomes useful. `cantHear` keeps it
  // too: whatever was heard before the drop is still the best evidence she has.
  if (micState === 'connecting') return null

  return (
    <div className={styles.heard}>
      <div className={styles.label}>Heard</div>
      <p className={styles.text} ref={textRef}>
        {transcript}
      </p>
    </div>
  )
}
