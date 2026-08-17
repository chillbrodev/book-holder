import type { CoachRecommendation } from '../../data/sessionClient'
import { Button } from '../core/Button'
import { BandHelp } from '../wrapup/BandHelp'
import { splitQuotedLine } from '../../utils/quotedLine'
import styles from './CoachNote.module.css'

export interface CoachNoteProps {
  /** Undefined while the agent is still deciding. */
  recommendation: CoachRecommendation | null | undefined
  loading: boolean
  onAct: (recommendation: CoachRecommendation) => void
}

/**
 * What the coach thinks she should do next, on the wrap-up.
 *
 * The one place in the app where a *decision* is shown rather than a
 * measurement. Everything else on this screen reports what happened; this says
 * what to do about it, and it is the only thing here that read her whole
 * history rather than this session.
 *
 * Nothing renders when there is nothing to say. The agent can answer "none",
 * and a clean run should get silence rather than an empty panel or manufactured
 * praise, a coach that speaks after every run is one you stop listening to.
 * Absence is the design, not a gap in it.
 *
 * It is also deliberately not styled as an alert. Terracotta belongs to "worth
 * another look"; this is the book holder speaking, so it takes gold, the same
 * colour the app uses for a thing that is working.
 *
 * The standfirst is worded to hold on both screens this appears on — the
 * wrap-up, where "this run" is on the page above it, and the play page, where
 * there is no run yet. It says what the note is drawn from and what it is for,
 * neither of which changes between the two.
 *
 * It exists because the panel was otherwise
 * unattributed: a sentence appeared, in the app's voice, with a button under it,
 * and nothing said who was talking or on what basis. It is one line, above the
 * note rather than below, and it says the two things that make the note worth
 * reading — that this looked at every rehearsal rather than only this one, and
 * that it is a suggestion rather than a verdict.
 */
export function CoachNote({ recommendation, loading, onAct }: CoachNoteProps) {
  if (loading) {
    return (
      <div className={styles.card} aria-busy="true">
        <div className={`bh-eyebrow ${styles.eyebrow}`}>From the book holder</div>
        {/* Same footprint as a real note, so the section doesn't jump when the
            agent answers — and no animation, matching the rehearsal's pending
            annotation and the Prompt Book's skeleton. */}
        <div className={styles.skeletonNote} />
        <div className={styles.skeletonAction} />
      </div>
    )
  }

  if (!recommendation) return null

  const label = recommendation.action === 'drill'
    ? recommendation.blockIds.length === 1
      ? 'Run that speech again'
      : `Drill those ${recommendation.blockIds.length} speeches`
    : `Run ${recommendation.act}.${recommendation.scene.toLowerCase()}`

  return (
    <div className={styles.card}>
      <div className={`bh-eyebrow ${styles.eyebrow}`}>From the book holder</div>
      <p className={styles.standfirst}>
        Read across every rehearsal you've saved — one suggestion for what to
        work on next, and why. Take it or leave it.
      </p>
      {/* The quoted line, set apart from the sentence carrying it.
          Straight quotation marks alone were doing all the work, and against a
          note full of elisions — "You've", "Herne's", "'twixt" — they simply
          read as more apostrophes. The line is the subject of the whole note and
          the thing she has to recognise, so it takes weight and colour and drops
          the marks that were failing to signal it. Falls back to the raw note
          when nothing was quoted, which is a real case: a scene-level
          recommendation names a scene instead. */}
      <p className={styles.note}>
        {(() => {
          const split = splitQuotedLine(recommendation.note)
          if (!split) return recommendation.note
          return (
            <>
              {split.before}
              <span className={styles.quotedLine}>{split.quote}</span>
              {split.after}
            </>
          )
        })()}
      </p>
      {/* The evidence, under the claim. Set quieter and smaller than the note
          because it is not addressed to her in the same way — the note is the
          coach speaking, this is it showing its working, and a reader who
          already agrees should be able to skip it.

          The agent writes it from the per-speech tallies in get_recent_misses,
          rather than the app composing it from the same numbers. That is
          deliberate: which marks make a speech worth running is a judgement, and
          a templated "2 dry, 4 close" would state the counts without saying why
          they add up to a recommendation. Absent entirely when it gave none. */}
      {recommendation.rationale && (
        <p className={styles.rationale}>
          {recommendation.rationale} <BandHelp />
        </p>
      )}
      <Button variant="secondary" onClick={() => onAct(recommendation)}>
        {label}
      </Button>
    </div>
  )
}
