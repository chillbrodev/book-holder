import type { Band } from '../../data/captureClient'

/**
 * What the three marks mean, in one place.
 *
 * Shared by the wrap-up's legend and the help bubble on the coach card. Two
 * copies would drift, and the failure would be invisible: both would read fine,
 * they would simply disagree about what "close" means.
 *
 * Each says what the band means about *the line*, never about her. "You had it"
 * and "it went" describe a delivery; "good" and "poor" would grade a person,
 * which is the boundary this app is built on — line mastery, not direction.
 */
export interface BandMeaning {
  band: Band
  name: string
  meaning: string
}

export const BAND_MEANINGS: BandMeaning[] = [
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
