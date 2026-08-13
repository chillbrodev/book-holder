import { cx } from '../../utils/cx'
import styles from './MasteryBar.module.css'

export interface MasteryBarProps {
  mastered: number
  total: number
  size?: 'sm' | 'md' | 'lg'
}

/** Bar + fraction combo; the fraction is the real signal, kept alongside the bar so equal mastery reads with equal confidence regardless of scene length. */
export function MasteryBar({ mastered, total, size = 'md' }: MasteryBarProps) {
  const pct = total > 0 ? Math.min(100, Math.round((mastered / total) * 100)) : 0
  return (
    <div className={styles.wrap}>
      <div className={cx(styles.track, styles[size])}>
        <div className={styles.fill} style={{ width: `${pct}%` }} />
      </div>
      <div className={styles.fraction}>
        {mastered} of {total}
      </div>
    </div>
  )
}
