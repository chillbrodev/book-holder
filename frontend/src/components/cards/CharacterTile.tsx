import { Icon } from '../core/Icon'
import { cx } from '../../utils/cx'
import styles from './CharacterTile.module.css'

export interface CharacterTileProps {
  name: string
  selected: boolean
  onClick: () => void
}

/** Grid tile for role selection — single-select, gold border + checkmark when selected. */
export function CharacterTile({ name, selected, onClick }: CharacterTileProps) {
  return (
    <div className={cx(styles.tile, selected && styles.selected)} onClick={onClick}>
      <span className={styles.name}>{name}</span>
      {selected && <Icon name="check" size={18} color="var(--bh-gold-dark)" strokeWidth={3} />}
    </div>
  )
}
