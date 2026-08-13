import { Icon } from '../core/Icon'
import { Badge } from '../core/Badge'
import { cx } from '../../utils/cx'
import styles from './FlaggedLineRow.module.css'

export interface FlaggedLineRowProps {
  text: string
  trailing?: 'replay' | 'chevron'
  mistakes?: number
  location?: string
  last?: string
  onClick?: () => void
  onReplay?: () => void
  isLast?: boolean
}

/** Dense flagged-line row, wrap-up uses a Replay button, the Prompt Book uses a mistake badge + chevron (tappable, launches focused practice). */
export function FlaggedLineRow({ text, trailing = 'replay', mistakes, location, last, onClick, onReplay, isLast = false }: FlaggedLineRowProps) {
  const clickable = trailing === 'chevron'
  return (
    <div
      className={cx(styles.row, isLast && styles.lastRow, clickable && styles.clickable)}
      onClick={clickable ? onClick : undefined}
    >
      <div className={styles.content}>
        {location && <div className={styles.location}>{location}</div>}
        <div className={cx(styles.text, location && styles.textWithLocation)}>{text}</div>
        {last && <div className={styles.lastPracticed}>Last practiced {last}</div>}
      </div>
      {trailing === 'replay' && (
        <button className={styles.replayButton} onClick={onReplay}>
          Replay
        </button>
      )}
      {trailing === 'chevron' && (
        <div className={styles.trailingGroup}>
          {typeof mistakes === 'number' && <Badge>{mistakes}&times;</Badge>}
          <Icon name="chevron-right" size={16} color="var(--bh-text-faint)" />
        </div>
      )}
    </div>
  )
}
