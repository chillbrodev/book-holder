/**
 * Finds the line the coach quoted inside its note, so the screen can set it
 * apart from the sentence around it.
 *
 * Harder than it looks, and the reason is the corpus. A note reads:
 *
 *   You've gone dry on 'To-night at Herne's oak, just 'twixt twelve and one,
 *   Must my sweet Nan present the Fairy Queen; The purpose why, is here;'.
 *
 * There are five apostrophes in that and only two of them are quotation marks.
 * Taking the first and second gives "To-night at Herne"; taking the first and
 * last gives the wrong start, because "You've" comes first. Elisions are
 * everywhere in Shakespeare — `'twixt`, `answer'd`, `o'er` — so any rule that
 * treats an apostrophe as a delimiter has to look at what surrounds it.
 *
 * The rule: an opening mark is preceded by nothing, whitespace or an opening
 * bracket, and followed by a word character. A closing mark is preceded by a
 * word character or punctuation, and followed by nothing, whitespace or
 * punctuation. Then take the first opener and the *last* closer after it, so
 * internal apostrophes fall inside the span rather than ending it early.
 *
 * Double and curly quotes are tried first, since they are unambiguous — the
 * model uses all three, and only the straight single quote collides with an
 * apostrophe.
 */
export interface SplitNote {
  before: string
  quote: string
  after: string
}

/** Ordered: unambiguous marks first, the apostrophe-shaped one last. */
const QUOTE_PAIRS: [open: string, close: string][] = [
  ['“', '”'], // “ ”
  ['"', '"'],
  ['‘', '’'], // ‘ ’
  ["'", "'"],
]

function isOpener(text: string, i: number): boolean {
  const before = i === 0 ? '' : text[i - 1]
  const after = text[i + 1] ?? ''
  return (before === '' || /[\s([]/.test(before)) && /[\w]/.test(after)
}

function isCloser(text: string, i: number): boolean {
  const before = text[i - 1] ?? ''
  const after = text[i + 1] ?? ''
  return /[\w.,;:!?)\]]/.test(before) && (after === '' || /[\s.,;:!?)\]]/.test(after))
}

/**
 * Splits a note around the line it quotes, or returns null when it quotes
 * nothing — which is a real case: a scene-level recommendation names a scene
 * instead, and there is then nothing to set apart.
 */
export function splitQuotedLine(note: string): SplitNote | null {
  for (const [open, close] of QUOTE_PAIRS) {
    const sameMark = open === close

    let start = -1
    for (let i = 0; i < note.length; i++) {
      if (note[i] === open && (!sameMark || isOpener(note, i))) {
        start = i
        break
      }
    }
    if (start === -1) continue

    let end = -1
    for (let i = note.length - 1; i > start; i--) {
      if (note[i] === close && (!sameMark || isCloser(note, i))) {
        end = i
        break
      }
    }
    if (end === -1) continue

    const quote = note.slice(start + 1, end).trim()
    // A span of a couple of characters is an elision that fooled the rules, not
    // a line of verse. Better to leave the note unstyled than to embolden "s".
    if (quote.length < 12) continue

    return {
      before: note.slice(0, start),
      quote,
      after: note.slice(end + 1),
    }
  }

  return null
}
