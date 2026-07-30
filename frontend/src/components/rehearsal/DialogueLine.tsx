import type { ReactNode } from 'react'
import { cx } from '../../utils/cx'
import styles from './DialogueLine.module.css'

export interface DialogueLineProps {
  speaker?: string
  coSpeakers?: string[]
  text: string
  active?: boolean
  micError?: boolean
  children?: ReactNode
}

/** A dialogue block — passed (muted, already spoken) or active (the current turn, gets the mic card treatment). Multi-speaker lines show a secondary "with X, Y" tag. */
export function DialogueLine({ speaker, coSpeakers, text, active = false, micError = false, children }: DialogueLineProps) {
  if (!active) {
    return (
      <div className={styles.passed}>
        <div className={styles.speaker}>{speaker}</div>
        {coSpeakers && coSpeakers.length > 0 && <div className={styles.coSpeakers}>with {coSpeakers.join(', ')}</div>}
        {/* Empty when the "Other lines" toggle is off — speaker name alone. */}
        {text && <div className={styles.passedText}>{text}</div>}
      </div>
    )
  }

  return (
    <div className={cx(styles.active, micError ? styles.activeAsh : styles.activeGold)}>
      <div className={styles.speaker}>{speaker}</div>
      {coSpeakers && coSpeakers.length > 0 && <div className={styles.coSpeakers}>with {coSpeakers.join(', ')}</div>}
      <div className={styles.activeText}>{text}</div>
      {children}
    </div>
  )
}
