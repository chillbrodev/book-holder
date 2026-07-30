import { Icon } from './Icon'
import type { IconName } from './Icon'
import { cx } from '../../utils/cx'
import styles from './ToggleButton.module.css'

export interface ToggleButtonProps {
  on: boolean
  /** What the control governs, e.g. "Your lines" — stays fixed as it toggles. */
  label: string
  /** The current state as a word ("Shown" / "Hidden"), never colour alone. */
  onStateLabel: string
  offStateLabel: string
  onIcon: IconName
  offIcon: IconName
  onClick: () => void
}

/**
 * Rehearsal control — on/off is carried three ways at once (icon, state word,
 * and fill), per the style guide's redundant-encoding rule. The label never
 * changes with state, so the button doesn't read as a different control after
 * being pressed; only the state word underneath moves.
 */
export function ToggleButton({ on, label, onStateLabel, offStateLabel, onIcon, offIcon, onClick }: ToggleButtonProps) {
  const state = on ? onStateLabel : offStateLabel
  return (
    <button
      type="button"
      className={cx(styles.button, on && styles.on)}
      onClick={onClick}
      aria-pressed={on}
      aria-label={`${label}: ${state}`}
    >
      <Icon name={on ? onIcon : offIcon} size={20} />
      <span className={styles.text}>
        <span className={styles.label}>{label}</span>
        <span className={styles.state}>{state}</span>
      </span>
    </button>
  )
}
