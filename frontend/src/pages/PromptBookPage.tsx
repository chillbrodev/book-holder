import { useNavigate } from 'react-router-dom'
import { getPlays, getSelectedRole } from '../data/client'
import { getPromptBook, type PromptBook } from '../data/sessionClient'
import { useAsync } from '../hooks/useAsync'
import { formatRelativeTime, toDisplayName } from '../utils/format'
import { MasteryBar } from '../components/mastery/MasteryBar'
import { FlaggedLineRow } from '../components/lists/FlaggedLineRow'
import { Button } from '../components/core/Button'
import { ApiError } from '../data/apiClient'
import styles from './PromptBookPage.module.css'

/** Enough rows to fill the fold, so the skeleton occupies roughly what the real
 * list will. Fewer would still jump when the data lands. */
const SKELETON_ROWS = 4

/**
 * The part, rather than a run of it.
 *
 * The wrap-up answers "how did that go"; this answers "where am I with this
 * part" — a question no single session can, which is why it reads `line_mastery`
 * (keyed (user, line), with no concept of a session) rather than a session row.
 *
 * Real data as of August 12 2026. It rendered on `data/mock/*` until now, with
 * fabricated line ids that drifted further from the corpus with every re-import;
 * the fixtures are deleted rather than left beside it, for the reason the
 * wrap-up's were.
 */
export function PromptBookPage() {
  const navigate = useNavigate()

  // The shelf is one play deep today, and the Prompt Book has no play picker of
  // its own — so it follows whichever part she has actually chosen. Taking the
  // id from the plays list rather than a hardcoded slug is what makes adding a
  // second play an import rather than a code change.
  const plays = useAsync(() => getPlays(), [])
  const playId = plays.data?.[0]?.id ?? ''

  const role = useAsync(
    () => (playId ? getSelectedRole(playId) : Promise.resolve(null)),
    [playId],
  )

  const book = useAsync(
    () => (playId && role.data ? getPromptBook(playId, role.data.id).catch(asNull) : Promise.resolve(null)),
    [playId, role.data?.id],
  )

  /**
   * True until the whole chain has settled, not just the last link.
   *
   * This page loads three things in sequence — plays, then her chosen part,
   * then the book — and each downstream call resolves `null` immediately while
   * its input is still missing. Reading only `book.loading` therefore reported
   * "loaded" during the first two, and the page rendered its "pick a part
   * first" state for a beat before replacing it with real data.
   *
   * That is worse than a slow page: it is a wrong page. Someone with a part
   * chosen was briefly told she had not chosen one.
   */
  const settling = plays.loading || role.loading || book.loading
  const failed = plays.error ?? role.error ?? book.error

  return (
    <div className={styles.wrap}>
      <h1 className="bh-h1">Prompt Book</h1>

      {/* The heading and the page frame render immediately and never unmount,
          so loading changes what is *inside* the page rather than replacing the
          page. The shared AsyncStatus swaps the whole screen for the word
          "Loading…", which on a page with a title and a progress bar reads as a
          navigation rather than a fetch. */}
      {settling
        ? <PromptBookSkeleton />
        : failed
        ? (
          <p className={styles.empty}>
            Something went wrong loading your prompt book. Try refreshing.
          </p>
        )
        : !role.data
        ? (
          <>
            <p className={styles.empty}>
              Pick a part first and the Book Holder will keep track of how you're getting on
              with it.
            </p>
            <Button variant="secondary" onClick={() => navigate('/shelf')}>
              Go to the shelf
            </Button>
          </>
        )
        : !book.data
        ? (
          <>
            <p className={styles.subhead}>{toDisplayName(role.data.name)}</p>
            <p className={styles.empty}>
              Nothing here yet. Rehearse a scene while signed in and this fills up with the
              lines worth another look.
            </p>
          </>
        )
        : <Book book={book.data} onDrill={(act, scene, lineId) =>
          navigate(
            `/play/${book.data!.playId}/rehearse/${act}/${scene}?line=${lineId}&back=${
              encodeURIComponent('/prompt-book')
            }`,
          )} />}
    </div>
  )
}

function Book(
  { book, onDrill }: {
    book: PromptBook
    onDrill: (act: string, scene: string, lineId: string) => void
  },
) {
  return (
    <>
      <p className={styles.subhead}>
        {book.playTitle} — {toDisplayName(book.characterName)}
      </p>

      <div className={styles.masteryBlock}>
        {/* Solid, not "not dry". A beat scored while Bedrock was unreachable
            carries no band at all (migration 009), and counting those as known
            would let an outage inflate her progress. */}
        <MasteryBar mastered={book.solidBeats} total={book.totalBeats} size="lg" />
        <p className={`bh-meta ${styles.masteryMeta}`}>
          {book.solidBeats} of {book.totalBeats} beats solid
          {book.practisedBeats > book.solidBeats && <> · {book.practisedBeats} run so far</>}
        </p>
      </div>

      {book.needsAnotherLook.length === 0
        ? (
          <p className={styles.empty}>
            {book.practisedBeats === 0
              ? 'Nothing here yet — rehearse a scene and the lines worth another look will collect here.'
              : "Nothing flagged. Everything you've run, you had."}
          </p>
        )
        : (
          <>
            <div className={`bh-eyebrow ${styles.sectionLabel}`}>Needs another look</div>
            <div className={styles.list}>
              {book.needsAnotherLook.map((beat, i) => (
                <FlaggedLineRow
                  key={beat.lineId}
                  text={beat.text}
                  trailing="chevron"
                  location={`Act ${beat.act} · Scene ${beat.scene}`}
                  mistakes={beat.mistakeCount}
                  last={beat.lastPractisedAt ? formatRelativeTime(beat.lastPractisedAt) : undefined}
                  isLast={i === book.needsAnotherLook.length - 1}
                  // The single-beat drill — it opens the whole speech around the
                  // beat (`getBlockForLine`), because a beat with no run-up into
                  // it isn't how the line is delivered.
                  onClick={() => onDrill(beat.act, beat.scene, beat.lineId)}
                />
              ))}
            </div>
          </>
        )}
    </>
  )
}

/**
 * The page's own shape, greyed out.
 *
 * Same footprint as the loaded page — subhead, mastery block, section label,
 * rows — so the content lands in place rather than pushing the page around. No
 * animation: this is a fetch that usually takes a few hundred milliseconds, and
 * a pulsing bar for that long draws more attention than the wait deserves.
 */
function PromptBookSkeleton() {
  return (
    <div aria-hidden="true">
      <div className={`${styles.skeleton} ${styles.skeletonSubhead}`} />
      <div className={styles.masteryBlock}>
        <div className={`${styles.skeleton} ${styles.skeletonBar}`} />
        <div className={`${styles.skeleton} ${styles.skeletonMeta}`} />
      </div>
      <div className={`${styles.skeleton} ${styles.skeletonLabel}`} />
      <div className={styles.list}>
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <div key={i} className={styles.skeletonRow}>
            <div className={`${styles.skeleton} ${styles.skeletonLocation}`} />
            <div className={`${styles.skeleton} ${styles.skeletonText}`} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** A 404/401 from the prompt book is "nothing recorded yet", not a failure —
 * the same distinction the wrap-up draws. */
function asNull(err: unknown) {
  if (err instanceof ApiError && (err.status === 404 || err.status === 401)) return null
  throw err
}
