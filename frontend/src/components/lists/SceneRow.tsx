import { MasteryBar } from '../mastery/MasteryBar'
import { cx } from '../../utils/cx'
import { pluralize } from '../../utils/format'
import styles from './SceneRow.module.css'

export interface SceneRowProps {
  title: string
  description?: string
  mastered: number
  total: number
  /** Lines the rehearsing character speaks here. Undefined when the list isn't
   * scoped to a character. */
  yourLines?: number
  current?: boolean
  onClick?: () => void
  isLast?: boolean
}

function sceneMeta(total: number, yourLines?: number): string {
  if (yourLines === undefined) return pluralize(total, 'line')
  if (yourLines === 0) return `You're not in this scene · ${pluralize(total, 'line')}`
  return `${pluralize(yourLines, 'line')} for you · ${total} in the scene`
}

/** Scene-picker row — title, short description, and either a mastery bar or,
 * before anything has been rehearsed, how much of the scene is actually yours.
 * Current scene gets a gold tint even mid-list. */
export function SceneRow({
  title,
  description,
  mastered,
  total,
  yourLines,
  current = false,
  onClick,
  isLast = false,
}: SceneRowProps) {
  return (
    <div className={cx(styles.row, current && styles.current, isLast && styles.last)} onClick={onClick}>
      <div className={styles.title}>{title}</div>
      {description && <div className={styles.description}>{description}</div>}
      <div className={styles.masteryRow}>
        {/* A bar reading "0 of 274" before the first run is noise, and claims
            progress that isn't tracked yet — say what's in the scene instead,
            and let the bar appear once it means something. */}
        {mastered > 0 ? (
          <MasteryBar mastered={mastered} total={total} size="sm" />
        ) : (
          <span className={styles.meta}>{sceneMeta(total, yourLines)}</span>
        )}
      </div>
    </div>
  )
}
