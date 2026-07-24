import { cx } from '../../utils/cx'
import styles from './StatCard.module.css'

export interface StatCardProps {
  value: string | number
  label: string
  tone?: 'neutral' | 'terracotta'
}

/** Small stat block for the scene wrap-up (duration, lines run, worth-another-look count). */
export function StatCard({ value, label, tone = 'neutral' }: StatCardProps) {
  return (
    <div className={cx(styles.card, tone === 'terracotta' && styles.terracotta)}>
      <div className={styles.value}>{value}</div>
      <div className={styles.label}>{label}</div>
    </div>
  )
}
