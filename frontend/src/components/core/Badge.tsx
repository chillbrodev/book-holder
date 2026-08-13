import type { ReactNode } from 'react'
import styles from './Badge.module.css'

export interface BadgeProps {
  children: ReactNode
}

/** Terracotta count badge for mistake counts, same family as mastery bars, so it reads as information, not a warning. */
export function Badge({ children }: BadgeProps) {
  return <div className={styles.badge}>{children}</div>
}
