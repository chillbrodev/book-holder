import type { MicState } from '../../hooks/useMicCapture'
import { Icon } from '../core/Icon'
import { cx } from '../../utils/cx'
import styles from './MicStateIndicator.module.css'

export interface MicStateIndicatorProps {
  state: MicState
  onTap: () => void
  /** Beats accounted for so far, and how many the speech has. Shown while
   * listening so she can see it following her rather than take "Listening" on
   * faith. */
  beatsCompleted?: number
  beatCount?: number
  /** She's gone quiet mid-thought. Changes what this says, because continuing to
   * claim "Listening" when the app has lost her is the thing that left her with
   * no idea what it wanted. */
  stalled?: boolean
  /**
   * The scene is holding on this speech because there was something worth
   * reading (`RehearsalPage.worthAPause`).
   *
   * Same reason `stalled` exists: "Captured, moving on…" beside a Continue
   * button and a scene that is deliberately standing still is the app narrating
   * behaviour it no longer has. Small, and exactly the kind of small that makes
   * an interface feel like it isn't paying attention.
   */
  holding?: boolean
}

const COPY: Record<MicState, { label: string; hint: string }> = {
  connecting: { label: 'Connecting mic…', hint: 'Tap the mic if it doesn’t start on its own.' },
  // Promises what the app now actually does, takes its cue from her stopping,
  // rather than instructing a tap. The tap still works and is also a real button
  // in the actions row, but it is a way out, not the way through.
  listening: { label: 'Listening', hint: 'Take it at your own pace — I’ll know when you’re done.' },
  processing: { label: 'Got it, one moment…', hint: 'Catching the last of it…' },
  captured: { label: 'Captured', hint: 'Moving on…' },
  cantHear: { label: "Can't hear you — check your mic", hint: 'The mic dropped — try again or call for the line.' },
}

/** The five mic states, icon and copy always change together, never a color shift alone. */
export function MicStateIndicator({
  state,
  onTap,
  beatsCompleted = 0,
  beatCount = 0,
  stalled = false,
  holding = false,
}: MicStateIndicatorProps) {
  // Stalled is a shading of `listening`, not a sixth state: the mic really is
  // still open and she can still carry on. `holding` is the same kind of
  // shading over `captured`; the speech is caught either way, and the only
  // difference is whether the scene is waiting on her to read something.
  const copy = stalled && state === 'listening'
    ? { label: 'Still listening — lost your thread', hint: 'Carry on, call for the line, or say you’re done.' }
    : holding && state === 'captured'
    ? { label: 'Captured', hint: 'Have a look — then carry on.' }
    : COPY[state]
  const isQuiet = state === 'connecting' || state === 'cantHear'
  // Only worth showing on a speech with several thoughts in it, on a one-beat
  // line it would read as a progress bar for a single sentence.
  const showProgress = state === 'listening' && !stalled && beatCount > 1

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        onClick={onTap}
        className={cx(styles.dial, isQuiet ? styles.dialAsh : styles.dialGold)}
        aria-label={copy.label}
      >
        {(state === 'connecting' || state === 'processing') && (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className={styles.spinner}>
            <circle
              cx="12"
              cy="12"
              r="9"
              stroke={state === 'connecting' ? 'var(--bh-ash-light)' : 'var(--bh-gold-light)'}
              strokeWidth="3"
              strokeDasharray="34 20"
              strokeLinecap="round"
            />
          </svg>
        )}
        {state === 'listening' && (
          <div className={styles.levelBars}>
            <div className={cx(styles.bar, styles.bar1)} />
            <div className={cx(styles.bar, styles.bar2)} />
            <div className={cx(styles.bar, styles.bar3)} />
          </div>
        )}
        {state === 'captured' && <Icon name="check" size={24} color="var(--bh-gold-light)" strokeWidth={3} />}
        {state === 'cantHear' && <Icon name="alert-triangle" size={22} color="var(--bh-ash-light)" />}
      </button>
      <div className={styles.copy}>
        <div className={styles.label}>
          {copy.label}
          {showProgress && (
            <span className={styles.progress}>
              {' '}
              · thought {Math.min(beatsCompleted + 1, beatCount)} of {beatCount}
            </span>
          )}
        </div>
        <div className={styles.hint}>{copy.hint}</div>
      </div>
    </div>
  )
}
