import type { MicState } from '../../hooks/useMicCapture'
import styles from './CaptureDebugInfo.module.css'

export interface CaptureDebugInfoProps {
  micState: MicState
  beatIndex: number
  beatCount: number
  transcript: string
}

/**
 * What the mic actually heard, under the live speech, outside production.
 *
 * The counterpart to BlockDebugInfo: that one answers "why does this line sound
 * wrong", this one answers "why did it think I said that". Both questions are
 * otherwise only answerable by tracing a request — and this one is about to
 * matter a great deal, because the fuzzy-match threshold (docs/OPEN_ITEMS.md §1a)
 * is the biggest open question in the product and it can only be settled by
 * watching real transcripts of real Shakespeare against the expected text.
 *
 * It is also the fastest way to catch the failure that would otherwise look like
 * a scoring bug: Transcribe has no idea what "uncomeliness" is, so an ASR miss
 * and her getting the line wrong arrive downstream identically
 * (docs/capture-plan.md §8).
 *
 * Rendered nowhere in a production build: `import.meta.env.PROD` is resolved
 * statically by Vite, so the whole subtree is dropped from the bundle rather than
 * merely hidden.
 */
export function CaptureDebugInfo({ micState, beatIndex, beatCount, transcript }: CaptureDebugInfoProps) {
  if (import.meta.env.PROD) return null

  return (
    <div className={styles.debug}>
      <div className={styles.row}>
        <span>
          <span className={styles.label}>mic</span> {micState}
        </span>
        <span>
          <span className={styles.label}>beat</span> {Math.min(beatIndex + 1, beatCount)}/{beatCount}
        </span>
      </div>
      {transcript && <div className={styles.transcript}>“{transcript}”</div>}
    </div>
  )
}
