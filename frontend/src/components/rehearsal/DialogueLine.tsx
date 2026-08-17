import type { ReactNode } from 'react'
import { blockDisplayLines } from '../../data/client'
import type { DialogueBlock } from '../../types/views'
import { cx } from '../../utils/cx'
import { BlockDebugInfo } from './BlockDebugInfo'
import { Teleprompter } from './Teleprompter'
import styles from './DialogueLine.module.css'

export interface DialogueLineProps {
  block: DialogueBlock
  active?: boolean
  micError?: boolean
  /** Replaces the block's text entirely, the held-back prompt on her own
   * lines, or the empty string when "Other lines" is toggled off. */
  overrideText?: string
  /**
   * Turns the block into a prompter that follows her, for her own live speech.
   *
   * Present only on the active user block; every other block on the page is
   * static text and renders exactly as before. See Teleprompter.tsx for why a
   * long speech cannot be laid out in page flow.
   *
   * Supersedes the old `promptedBeat`, which appended each revealed beat to a
   * growing paragraph and joined `beat.text` — losing verse lineation entirely,
   * because `text` is the source lines already run together.
   */
  prompter?: {
    beatIndex: number
    /** Draw the shape only, without the words. */
    masked?: boolean
    frozen?: boolean
  }
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
  prompter,
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
      {prompter
        ? (
          <Teleprompter
            block={block}
            beatIndex={prompter.beatIndex}
            masked={prompter.masked}
            frozen={prompter.frozen}
            className={styles.prompterPane}
          />
        )
        : body}
      <BlockDebugInfo block={block} />
      {children}
    </div>
  )
}
