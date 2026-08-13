import type { ReactNode } from 'react'
import { blockDisplayLines } from '../../data/client'
import type { DialogueBlock } from '../../types/views'
import { cx } from '../../utils/cx'
import { BlockDebugInfo } from './BlockDebugInfo'
import styles from './DialogueLine.module.css'

export interface DialogueLineProps {
  block: DialogueBlock
  active?: boolean
  micError?: boolean
  /** Replaces the block's text entirely, the held-back prompt on her own
   * lines, or the empty string when "Other lines" is toggled off. */
  overrideText?: string
  /** Shown after the block when she's called for a prompt: the next beat only,
   * never the whole speech. A block can be sixteen thoughts long, and handing
   * her all of them isn't a prompt, it's the answer. */
  promptedBeat?: string
  children?: ReactNode
}

/**
 * One speech, under one speaker header, the unit of display and of a single
 * Polly render (docs/beats-and-blocks-plan.md §2). Passed blocks are muted;
 * the active one gets the mic card treatment.
 *
 * Verse renders its own lineation, prose flows as a paragraph. Multi-speaker
 * blocks show a secondary "with X, Y" tag.
 */
export function DialogueLine({
  block,
  active = false,
  micError = false,
  overrideText,
  promptedBeat,
  children,
}: DialogueLineProps) {
  const showBlockText = overrideText === undefined
  const lines = showBlockText ? blockDisplayLines(block) : [overrideText]

  const body = lines.map((line, i) => (
    <div
      key={i}
      className={cx(active ? styles.activeText : styles.passedText, showBlockText && block.isVerse && styles.verseLine)}
    >
      {line}
    </div>
  ))

  const header = (
    <>
      <div className={styles.speaker}>{block.speaker}</div>
      {block.coSpeakers && block.coSpeakers.length > 0 && (
        <div className={styles.coSpeakers}>with {block.coSpeakers.join(', ')}</div>
      )}
    </>
  )

  if (!active) {
    return (
      <div className={styles.passed}>
        {header}
        {/* Empty when the "Other lines" toggle is off — speaker name alone. */}
        {overrideText !== '' && body}
        {/* Stays put even with the text toggled off: it identifies the block,
            which is exactly what's being checked when the text is hidden. */}
        <BlockDebugInfo block={block} />
      </div>
    )
  }

  return (
    <div className={cx(styles.active, micError ? styles.activeAsh : styles.activeGold)}>
      {header}
      {body}
      {promptedBeat && <div className={styles.promptedBeat}>{promptedBeat}</div>}
      <BlockDebugInfo block={block} />
      {children}
    </div>
  )
}
