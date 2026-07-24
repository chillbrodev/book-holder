import type { ReactNode } from 'react'
import styles from './IdentityTag.module.css'

export interface IdentityTagProps {
  children: ReactNode
}

/** Small pill showing which character the user is rehearsing — sits atop the scene picker. */
export function IdentityTag({ children }: IdentityTagProps) {
  return <div className={styles.tag}>{children}</div>
}
