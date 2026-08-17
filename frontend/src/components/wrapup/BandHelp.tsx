import { useId } from 'react'
import { BAND_MEANINGS } from './bands'
import styles from './BandHelp.module.css'

/**
 * A question mark that explains the three bands where they are used in passing.
 *
 * The wrap-up can afford a full legend because it sits directly above a list of
 * marks. The coach card cannot: it mentions "2 solid, 8 close, and 1 dry" inside
 * a sentence, and three rows of glossary under a two-line note would outweigh the
 * note. So the explanation is available rather than present.
 *
 * Opens on hover *and* on keyboard focus, and it is a real `<button>` rather
 * than a styled span, because a tooltip reachable only by pointer is not
 * reachable at all for anyone using a keyboard or a screen reader. `aria-
 * describedby` ties the bubble to the control, so the description is announced
 * rather than discovered.
 *
 * `useId` because this can appear more than once on a page — the wrap-up shows a
 * coach card and a speech list — and two elements sharing an id would point
 * every control at the first bubble.
 */
export function BandHelp() {
  const id = useId()

  return (
    <span className={styles.wrap}>
      <button type="button" className={styles.trigger} aria-describedby={id} aria-label="What solid, close and dry mean">
        ?
      </button>
      <span role="tooltip" id={id} className={styles.bubble}>
        {BAND_MEANINGS.map(({ band, name, meaning }) => (
          <span key={band} className={styles.row}>
            <span className={`${styles.mark} ${styles[band]}`} aria-hidden="true" />
            <span>
              <strong className={styles.name}>{name}</strong> — {meaning}
            </span>
          </span>
        ))}
      </span>
    </span>
  )
}
