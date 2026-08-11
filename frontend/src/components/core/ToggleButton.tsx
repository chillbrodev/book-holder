import { Icon } from './Icon'
import type { IconName } from './Icon'
import { cx } from '../../utils/cx'
import styles from './ToggleButton.module.css'

export interface ToggleButtonProps {
  on: boolean
  /** What the control governs, e.g. "Your lines" — stays fixed as it toggles. */
  label: string
  /**
   * The same control named for a ~90px-wide button, e.g. "Yours" — used only in
   * the phone's bottom bar, where four of these share the screen width.
   *
   * Both spellings are always in the DOM and CSS picks one, rather than a
   * `compact` prop driven by a JS breakpoint. A width-matching-media query is
   * the browser's job: it re-evaluates on rotation and on a resized desktop
   * window with no re-render, and there is no first-paint frame where the
   * wrong one is showing. Falls back to `label` when unset, so callers outside
   * the rehearsal bar need not care.
   */
  shortLabel?: string
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
export function ToggleButton({
  on,
  label,
  shortLabel,
  onStateLabel,
  offStateLabel,
  onIcon,
  offIcon,
  onClick,
}: ToggleButtonProps) {
  const state = on ? onStateLabel : offStateLabel
  return (
    <button
      type="button"
      className={cx(styles.button, on && styles.on)}
      onClick={onClick}
      aria-pressed={on}
      /* Always the full label, whichever spelling is on screen — the abbreviation
         is a space compromise and shouldn't reach a screen reader. This also makes
         the duplicated text below invisible to AT, since aria-label supersedes the
         element's contents. */
      aria-label={`${label}: ${state}`}
    >
      <Icon name={on ? onIcon : offIcon} size={20} />
      <span className={styles.text}>
        <span className={styles.label}>
          <span className={styles.labelFull}>{label}</span>
          <span className={styles.labelShort}>{shortLabel ?? label}</span>
        </span>
        <span className={styles.state}>{state}</span>
      </span>
    </button>
  )
}
