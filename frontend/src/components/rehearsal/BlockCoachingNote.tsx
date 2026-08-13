import type { BlockScored } from '../../hooks/useMicCapture'
import styles from './BlockCoachingNote.module.css'

export interface BlockCoachingNoteProps {
  /** Undefined while the coach hasn't answered, which includes "never will",
   * on a socket she closed by walking away. */
  coaching: BlockScored | undefined
  /** How many beats this block has, so the slot can be the right height before
   * there is anything to put in it. */
  beatCount: number
}

/**
 * How the block went, under the block.
 *
 * `docs/coaching-plan.md` §4, and the two rules that shape it:
 *
 * The slot is reserved from the start. It renders at its full height while
 * empty, so the score arriving never pushes the speech she is currently reading
 * down the page. Text moving under an actor mid-scene reads as a bug. The cost
 * is some vertical space on an unscored block; the benefit is a script that
 * never reflows.
 *
 * Nothing here interrupts. No sound, no motion that pulls the eye, nothing
 * to dismiss, and nothing that has to be read. She can ignore this column
 * entirely and the rehearsal is identical.
 *
 * Bands, never percentages, *solid* / *close* / *dry*. A number is a grade,
 * and the style guide's voice is backstage crew rather than a teacher. Each band
 * carries its own word as well as its colour, per the redundant-encoding rule;
 * the colour alone is never the message.
 */
export function BlockCoachingNote({ coaching, beatCount }: BlockCoachingNoteProps) {
  if (!coaching) {
    return (
      <div className={styles.slot} aria-hidden="true">
        <div className={styles.pending}>
          {Array.from({ length: beatCount }, (_, index) => (
            <span key={index} className={styles.pendingPill} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.slot}>
      {/* One region, one announcement. `polite` so a screen reader finishes the
          sentence she is on rather than cutting across a rehearsal — the same
          principle as the visual rule above. */}
      <div className={styles.bands} role="status" aria-live="polite">
        {coaching.beats.map((beat, index) => (
          <span key={beat.lineId} className={`${styles.pill} ${styles[beat.band]}`}>
            <span className={styles.pillIndex}>{index + 1}</span>
            {beat.band}
          </span>
        ))}
      </div>
      {coaching.note.length > 0 && <p className={styles.note}>{coaching.note}</p>}
      {/* Said only when it is true, and said quietly.
          `fallback` means Bedrock was unreachable and these bands came from word
          overlap rather than judgement — which cannot tell a paraphrase from a
          miss, and is exactly the thing the coach exists to do. Without this the
          two are indistinguishable on screen, and an app that silently overstates
          how well it understood her is worse than one that admits it didn't. */}
      {coaching.source === 'fallback' && (
        <p className={`bh-meta ${styles.degraded}`}>
          Matched on words this time — the coach couldn't be reached.
        </p>
      )}
    </div>
  )
}
