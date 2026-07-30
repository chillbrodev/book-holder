import { Icon } from '../core/Icon'
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

/** Grid tile for role selection — single-select, gold border + checkmark when selected. */
export function CharacterTile({ name, lineCount, sceneCount, selected, onClick }: CharacterTileProps) {
  return (
    <div className={cx(styles.tile, selected && styles.selected)} onClick={onClick}>
      <div className={styles.header}>
        <span className={styles.name}>{name}</span>
        {selected && <Icon name="check" size={18} color="var(--bh-gold-dark)" strokeWidth={3} />}
      </div>
      <span className={styles.meta}>
        {pluralize(lineCount, 'line')} · {pluralize(sceneCount, 'scene')}
      </span>
    </div>
  )
}
