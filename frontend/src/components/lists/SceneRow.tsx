import { MasteryBar } from '../mastery/MasteryBar'
import { cx } from '../../utils/cx'
import styles from './SceneRow.module.css'

export interface SceneRowProps {
  title: string
  description?: string
  mastered: number
  total: number
  current?: boolean
  onClick?: () => void
  isLast?: boolean
}

/** Scene-picker row — title, short description, mastery bar + fraction. Current scene gets a gold tint even mid-list. */
export function SceneRow({ title, description, mastered, total, current = false, onClick, isLast = false }: SceneRowProps) {
  return (
    <div className={cx(styles.row, current && styles.current, isLast && styles.last)} onClick={onClick}>
      <div className={styles.title}>{title}</div>
      {description && <div className={styles.description}>{description}</div>}
      <div className={styles.masteryRow}>
        <MasteryBar mastered={mastered} total={total} size="sm" />
      </div>
    </div>
  )
}
