import type { ReactNode } from 'react'
import styles from './StageDirection.module.css'

export interface StageDirectionProps {
  children: ReactNode
}

/** Centered, italic, muted stage direction — inline between speech blocks, never a card or modal. */
export function StageDirection({ children }: StageDirectionProps) {
  return <div className={styles.direction}>{children}</div>
}
