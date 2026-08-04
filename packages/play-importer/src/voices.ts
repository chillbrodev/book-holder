/**
 * Per-character Polly voice, assigned at import.
 *
 * British English neural voices, Amy for women and Brian for men, per
 * docs/BE_PLAN.md §44. This lives in the importer rather than in a migration
 * because migrations run once: an assignment made by UPDATE survives exactly
 * until the next re-import mints new character rows, which is how the original
 * one was lost. Assigning at import means there is never a window where a
 * character is NULL and quietly falls back to the default voice.
 *
 * Gender is listed explicitly rather than guessed. There is no reliable signal
 * in the Moby source — <PERSONA> descriptions are free text and often absent —
 * and the failure mode of a guess is voicing a character wrong for an entire
 * play.
 */

const FEMALE_VOICE = "Amy";
const MALE_VOICE = "Brian";

/**
 * Female speaking roles, keyed by play title, matched case-insensitively
 * against the <SPEAKER> name the importer derives.
 *
 * Anything not listed gets the male voice. That default is only sound because
 * these lists are curated per play — adding a play without adding its women
 * here voices all of them as men, which is why `voiceFor` reports an unknown
 * title rather than silently guessing.
 *
 * Note the names are the Moby <SPEAKER> forms, which differ from the cast-list
 * forms: "MISTRESS FORD" here is StageAgent's "Mrs. Ford".
 *
 * Sources — cite one whenever a play is added, so the next person doesn't have
 * to re-derive it:
 *   The Merry Wives of Windsor —
 *     https://stageagent.com/shows/play/14305/the-merry-wives-of-windsor/characters
 *     Confirms the two that look like judgment calls and aren't: William Page
 *     and Robin are both listed Male despite being boys, and the Ensemble is
 *     "Either Gender", matching the UNVOICED treatment of "All" below.
 */
const FEMALE_ROLES: Record<string, string[]> = {
  "The Merry Wives of Windsor": [
    "MISTRESS FORD",
    "MISTRESS PAGE",
    "MISTRESS QUICKLY",
    "ANNE PAGE",
  ],
};

/** Roles the text gives no gender for — a crowd rather than a person. Left
 * unset so PollyService falls back to POLLY_DEFAULT_VOICE_ID rather than
 * asserting something the source doesn't say. StageAgent lists Merry Wives'
 * equivalent as "Ensemble (Either Gender)".
 *
 * The unnamed servants are deliberately *not* here: they're individual
 * speaking roles, and while StageAgent doesn't list them at all, they take the
 * male default rather than a fallback. Audibly identical either way. */
const UNVOICED = ["ALL", "CHORUS"];

export interface VoiceAssignment {
  voiceId: string | null;
  /** True when the play has no curated list, so nothing was assigned. */
  unknownPlay: boolean;
}

export function voiceFor(playTitle: string, characterName: string): VoiceAssignment {
  const female = FEMALE_ROLES[playTitle];
  if (!female) return { voiceId: null, unknownPlay: true };

  const key = characterName.trim().toUpperCase();
  if (UNVOICED.includes(key)) return { voiceId: null, unknownPlay: false };

  const isFemale = female.some((name) => name.toUpperCase() === key);
  return { voiceId: isFemale ? FEMALE_VOICE : MALE_VOICE, unknownPlay: false };
}

export const VOICES = { FEMALE_VOICE, MALE_VOICE, FEMALE_ROLES };
