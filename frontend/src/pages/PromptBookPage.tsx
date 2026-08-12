import { useNavigate } from 'react-router-dom'
import { getPlays, getSelectedRole } from '../data/client'
import { getPromptBook } from '../data/sessionClient'
import { useAsync } from '../hooks/useAsync'
import { formatRelativeTime, toDisplayName } from '../utils/format'
import { MasteryBar } from '../components/mastery/MasteryBar'
import { FlaggedLineRow } from '../components/lists/FlaggedLineRow'
import { AsyncStatus } from '../components/core/AsyncStatus'
import { Button } from '../components/core/Button'
import { ApiError } from '../data/apiClient'
import styles from './PromptBookPage.module.css'

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
  const { data: plays } = useAsync(() => getPlays(), [])
  const playId = plays?.[0]?.id ?? ''
  const { data: role } = useAsync(() => (playId ? getSelectedRole(playId) : Promise.resolve(null)), [playId])

  const { data: book, loading, error } = useAsync(
    () => (playId && role ? getPromptBook(playId, role.id).catch(asNull) : Promise.resolve(null)),
    [playId, role?.id],
  )

  if (loading || error) return <AsyncStatus loading={loading} error={error} />

  // No part chosen yet, or signed out. Both are "there is nothing to show",
  // which is a real state rather than a failure — and the fix for each is a
  // different sentence, so they don't share one.
  if (!role) {
    return (
      <div className={styles.wrap}>
        <h1 className="bh-h1">Prompt Book</h1>
        <p className={styles.empty}>
          Pick a part first and the Book Holder will keep track of how you're getting on with it.
        </p>
        <Button variant="secondary" onClick={() => navigate('/shelf')}>
          Go to the shelf
        </Button>
      </div>
    )
  }

  if (!book) {
    return (
      <div className={styles.wrap}>
        <h1 className="bh-h1">Prompt Book</h1>
        <p className={styles.subhead}>{toDisplayName(role.name)}</p>
        <p className={styles.empty}>
          Nothing here yet. Rehearse a scene while signed in and this fills up with the
          lines worth another look.
        </p>
      </div>
    )
  }

  return (
    <div className={styles.wrap}>
      <h1 className="bh-h1">Prompt Book</h1>
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
          {book.practisedBeats > book.solidBeats && (
            <> · {book.practisedBeats} run so far</>
          )}
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
                  // The single-beat drill, same as before — it opens the whole
                  // speech around the beat (`getBlockForLine`), because a beat
                  // with no run-up into it isn't how the line is delivered.
                  onClick={() =>
                    navigate(
                      `/play/${book.playId}/rehearse/${beat.act}/${beat.scene}?line=${beat.lineId}&back=${
                        encodeURIComponent('/prompt-book')
                      }`,
                    )}
                />
              ))}
            </div>
          </>
        )}
    </div>
  )
}

/** A 404/401 from the prompt book is "nothing recorded yet", not a failure —
 * the same distinction the wrap-up draws. */
function asNull(err: unknown) {
  if (err instanceof ApiError && (err.status === 404 || err.status === 401)) return null
  throw err
}
