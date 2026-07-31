import { blockVerseLines } from '../../data/fixtureClient'
import type { DialogueBlock } from '../../types/views'
import { cx } from '../../utils/cx'
import styles from './DialogueBlockView.module.css'

export interface DialogueBlockViewProps {
  block: DialogueBlock
  active?: boolean
  /** Draws the beat divisions — the units the coach scores. Off during a real
   * run (a beat boundary is not something she should be reading around), on
   * here so the segmentation can actually be judged. */
  showBeats?: boolean
}

/**
 * One speech, under one speaker header.
 *
 * Verse renders its own lineation from `sourceLines`, because that is how a
 * part is memorized and the joined beat text cannot reproduce it. Prose renders
 * as flowing text — its "lines" are just Moby's fixed-width wrapping, which
 * would look arbitrary at any width but the one it was typeset for.
 */
export function DialogueBlockView({ block, active = false, showBeats = false }: DialogueBlockViewProps) {
  return (
    <div className={cx(styles.block, active && styles.active)}>
      <div className={styles.header}>
        <span className={styles.speaker}>{block.speaker}</span>
        {block.coSpeakers && <span className={styles.coSpeakers}>with {block.coSpeakers.join(', ')}</span>}
        <span className={styles.form}>{block.isVerse ? 'verse' : 'prose'}</span>
      </div>

      {block.isVerse ? (
        <div className={styles.verse}>
          {blockVerseLines(block).map((line, i) => (
            <div key={i} className={styles.verseLine}>
              {line}
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.prose}>{block.beats.map((beat) => beat.text).join(' ')}</p>
      )}

      {showBeats && (
        <ol className={styles.beats}>
          {block.beats.map((beat) => (
            <li key={beat.lineId} className={cx(styles.beat, beat.text.length > 200 && styles.beatLong)}>
              <span className={styles.beatNumber}>{beat.beatNumber}</span>
              <span className={styles.beatText}>{beat.text}</span>
              <span className={styles.beatChars}>{beat.text.length}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
