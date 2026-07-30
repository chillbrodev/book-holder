import { cx } from '../../utils/cx'
import { pluralize } from '../../utils/format'
import styles from './CharacterTile.module.css'

export interface CharacterTileProps {
  name: string
  /** Spoken lines across the whole play — the main "how big is this part?" signal. */
  lineCount: number
  /** Distinct scenes the character appears in. */
  sceneCount: number
  selected: boolean
  onClick: () => void
}

/**
 * Grid tile for role selection — gold fill and ring when selected.
 *
 * No checkmark: it competed with the name for the same row, so selecting a
 * two-word part wrapped the name and made that tile taller than its
 * neighbours. The fill, ring and gold text carry the state, and aria-pressed
 * carries it for anyone not seeing colour at all.
 */
export function CharacterTile({ name, lineCount, sceneCount, selected, onClick }: CharacterTileProps) {
  return (
    <button
      type="button"
      className={cx(styles.tile, selected && styles.selected)}
      onClick={onClick}
      aria-pressed={selected}
    >
      <span className={styles.name}>{name}</span>
      <span className={styles.meta}>
        {pluralize(lineCount, 'line')} · {pluralize(sceneCount, 'scene')}
      </span>
    </button>
  )
}
