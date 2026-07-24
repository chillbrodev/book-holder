import type { PlayStatus } from '../../types/views'
import { Icon } from '../core/Icon'
import { MasteryBar } from '../mastery/MasteryBar'
import { cx } from '../../utils/cx'
import styles from './PlayCard.module.css'

export interface PlayCardProps {
  title: string
  status?: PlayStatus
  locked?: boolean
  favorite?: boolean
  mastered?: number
  total?: number
  onClick?: () => void
}

const BAR_CLASS: Record<PlayStatus, string> = {
  focus: styles.barGold,
  favorite: styles.barGold,
  inProgress: styles.barTerracotta,
  neutral: styles.barAsh,
  locked: styles.barAsh,
}

/** The "book spine" play card — solid color bar signals status, 2px gold border reserved for the one focus play at a time. */
export function PlayCard({ title, status = 'neutral', locked = false, favorite = false, mastered = 0, total = 0, onClick }: PlayCardProps) {
  const effectiveStatus = locked ? 'locked' : status

  return (
    <div className={cx(styles.card, status === 'focus' && styles.focusBorder, locked && styles.locked)} onClick={locked ? undefined : onClick}>
      {status !== 'focus' && <div className={cx(styles.bar, BAR_CLASS[effectiveStatus])} />}
      <div className={styles.body}>
        <div className={styles.title}>{title}</div>
        {locked && (
          <div className={styles.statusRow}>
            <Icon name="lock" size={14} color="var(--bh-ash-dark)" /> Coming soon
          </div>
        )}
        {!locked && favorite && (
          <div className={cx(styles.statusRow, styles.statusGold)}>
            <Icon name="star" size={14} color="var(--bh-gold-mid)" /> Saved for later
          </div>
        )}
        {!locked && total > 0 && (
          <div className={styles.masteryRow}>
            <MasteryBar mastered={mastered} total={total} size="sm" />
          </div>
        )}
      </div>
    </div>
  )
}
