import { Button } from '../core/Button'
import type { SpeechSummary } from '../../data/sessionClient'
import type { Band } from '../../data/captureClient'
import { cx } from '../../utils/cx'
import styles from './SpeechScore.module.css'

export interface SpeechScoreProps {
  speech: SpeechSummary
  /** 1-based, for the heading. The block id is the real identity; this is only
   * how she refers to "the third one". */
  ordinal: number
  onRunAgain: () => void
}

const BAND_LABEL: Record<Band, string> = {
  solid: 'solid',
  close: 'close',
  dry: 'dry',
}

/**
 * How one speech went, beat by beat.
 *
 * The bands were previously shown live, under the speech, while she was still in
 * the scene — and were then gone. That placement was reversed deliberately: mid
 * rehearsal is the worst moment to read a score, because she is either still
 * performing or about to be, and the marks scrolled away with the speech. Here
 * they are a record she can sit with.
 *
 * Beat by beat rather than a per-speech average, because a beat is the unit the
 * coach actually scored (`docs/beats-and-blocks-plan.md` §2) and averaging it
 * away would throw out the one thing she needs: *which* thought went.
 *
 * A band, never a percentage. `solid`/`close`/`dry` is what someone in the wings
 * says; 62% is a grade, and the style guide's voice is backstage crew.
 */
export function SpeechScore({ speech, ordinal, onRunAgain }: SpeechScoreProps) {
  const counts = speech.beats.reduce<Record<string, number>>((tally, beat) => {
    const key = beat.band ?? 'unjudged'
    tally[key] = (tally[key] ?? 0) + 1
    return tally
  }, {})

  // Worth re-running when anything fell short. A speech she had needs no button:
  // offering to drill a clean speech is the app inventing work for her.
  const worthRunning = speech.beats.some((beat) => beat.band !== 'solid')

  const summaryLine = (['solid', 'close', 'dry'] as const)
    .filter((band) => counts[band])
    .map((band) => `${counts[band]} ${BAND_LABEL[band]}`)
    .join(' · ')

  return (
    <div className={styles.speech}>
      <div className={styles.head}>
        <span className={styles.title}>Speech {ordinal}</span>
        <span className={styles.marks} aria-hidden="true">
          {speech.beats.map((beat, i) => (
            <span key={i} className={cx(styles.mark, beat.band && styles[beat.band])} />
          ))}
        </span>
        {/* The marks above are decorative; this is the same information as text,
            which is what a screen reader and a colour-blind reader get. */}
        <span className={`bh-meta ${styles.tally}`}>{summaryLine}</span>
      </div>

      <ol className={styles.beats}>
        {speech.beats.map((beat) => (
          <li key={beat.lineId} className={styles.beat}>
            <span
              className={cx(styles.mark, styles.beatMark, beat.band && styles[beat.band])}
              aria-hidden="true"
            />
            <span className={cx(styles.beatText, beat.band === 'dry' && styles.dryText)}>
              {beat.text}
            </span>
            {/* Named only where it matters. Labelling all sixteen beats turns the
                list into a wall of chips and buries the three she needs to see. */}
            {beat.band && beat.band !== 'solid' && (
              <span className={cx(styles.badge, styles[beat.band])}>{BAND_LABEL[beat.band]}</span>
            )}
            {beat.band === null && <span className={`bh-meta ${styles.unjudged}`}>not judged</span>}
          </li>
        ))}
      </ol>

      {/* The coach's own words about this speech, when there were any. Silence is
          the common case and is correct (`docs/coaching-plan.md` §4). */}
      {speech.note && <p className={styles.note}>{speech.note}</p>}

      {worthRunning && (
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onRunAgain}>
            Run this speech again
          </Button>
        </div>
      )}
    </div>
  )
}
