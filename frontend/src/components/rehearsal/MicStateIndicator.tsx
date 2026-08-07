import type { MicState } from '../../hooks/useMicCapture'
import { Icon } from '../core/Icon'
import { cx } from '../../utils/cx'
import styles from './MicStateIndicator.module.css'

export interface MicStateIndicatorProps {
  state: MicState
  onTap: () => void
}

const COPY: Record<MicState, { label: string; hint: string }> = {
  connecting: { label: 'Connecting mic…', hint: 'Tap the mic once it connects.' },
  listening: { label: 'Listening', hint: "Tap when the line's been said." },
  processing: { label: 'Got it, one moment…', hint: 'Hold on…' },
  captured: { label: 'Captured', hint: 'Tap to move on.' },
  cantHear: { label: "Can't hear you — check your mic", hint: 'The mic dropped — try again or call for the line.' },
}

/** The five mic states — icon and copy always change together, never a color shift alone. */
export function MicStateIndicator({ state, onTap }: MicStateIndicatorProps) {
  const copy = COPY[state]
  const isQuiet = state === 'connecting' || state === 'cantHear'

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
        <div className={styles.label}>{copy.label}</div>
        <div className={styles.hint}>{copy.hint}</div>
      </div>
    </div>
  )
}
