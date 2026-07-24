import { Icon } from '../core/Icon'
import { cx } from '../../utils/cx'
import styles from './CharacterRow.module.css'

export interface CharacterRowProps {
  name: string
  selected: boolean
  onClick: () => void
  isLast?: boolean
}

/** Bordered, dense-list row for role selection — never a card. Single-select, gold checkmark. */
export function CharacterRow({ name, selected, onClick, isLast = false }: CharacterRowProps) {
  return (
    <div className={cx(styles.row, selected && styles.selected, isLast && styles.last)} onClick={onClick}>
      <span className={styles.name}>{name}</span>
      {selected && <Icon name="check" size={20} color="var(--bh-gold-dark)" strokeWidth={3} />}
    </div>
  )
}
