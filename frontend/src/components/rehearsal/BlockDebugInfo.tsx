import type { DialogueBlock } from '../../types/views'
import styles from './BlockDebugInfo.module.css'

export interface BlockDebugInfoProps {
  block: DialogueBlock
}

/**
 * The block's id, under the speech, outside production.
 *
 * The value every audio question comes down to, the S3 cache key is
 * {play}/{character}/{blockId}__{voiceId}__{engine}.mp3 (api's
 * polly/service.ts), and the block id is the part of it the screen can't
 * otherwise tell you. So "why does this line sound wrong" is answerable off
 * the screen instead of by tracing the request.
 *
 * Rendered nowhere in a production build: `import.meta.env.PROD` is resolved
 * statically by Vite, so the whole subtree is dropped from the bundle rather
 * than merely hidden.
 */
export function BlockDebugInfo({ block }: BlockDebugInfoProps) {
  if (import.meta.env.PROD) return null

  return (
    <div className={styles.debug}>
      <span className={styles.field}>
        <span className={styles.label}>block</span>
        <span className={styles.value}>{block.blockId}</span>
      </span>
    </div>
  )
}
