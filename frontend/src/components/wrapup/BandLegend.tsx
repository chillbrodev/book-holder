import styles from './BandLegend.module.css'

const BANDS = [
  {
    band: 'solid' as const,
    name: 'Solid',
    meaning: 'You had it. The words were there and in the right order.',
  },
  {
    band: 'close' as const,
    name: 'Close',
    meaning: "You had the thought but not quite the line — a word swapped, dropped, or turned around.",
  },
  {
    band: 'dry' as const,
    name: 'Dry',
    meaning: 'It went. Either nothing came, or what came was not this line.',
  },
]

/**
 * What the three marks mean, said once, above the speeches they mark.
 *
 * The bands were named for the register an actor actually uses — "dry" is what
 * someone in the wings says when you lose a line — and that is exactly why they
 * need glossing: they read as tone rather than as measurement, and nothing on
 * this page previously said what they were. A legend is cheaper than renaming
 * them into something blander.
 *
 * It says what each band means about *the line*, never about her. "You had it"
 * and "it went" describe a delivery; "good" and "poor" would be grading a
 * person, which is the boundary this whole app is built on — line mastery, not
 * direction.
 *
 * The marks here are the same elements as in the list below, sharing the band
 * class names, so the legend cannot drift from what it explains.
 */
export function BandLegend() {
  return (
    <dl className={styles.legend}>
      {BANDS.map(({ band, name, meaning }) => (
        <div key={band} className={styles.row}>
          <dt className={styles.term}>
            <span className={`${styles.mark} ${styles[band]}`} aria-hidden="true" />
            {name}
          </dt>
          <dd className={styles.meaning}>{meaning}</dd>
        </div>
      ))}
    </dl>
  )
}
