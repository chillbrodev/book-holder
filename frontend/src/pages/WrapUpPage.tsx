import { useNavigate, useParams } from 'react-router-dom'
import { getScenesSummary, getSelectedRole } from '../data/client'
import { getBlockAudio } from '../data/pollyClient'
import { playUrl, unlockPlayback } from '../utils/audioPlayback'
import { getSessionSummary, type SessionSummary } from '../data/sessionClient'
import { pendingSessionSave } from '../data/pendingSessionSave'
import { ApiError } from '../data/apiClient'
import { useAsync } from '../hooks/useAsync'
import { StatCard } from '../components/cards/StatCard'
import { FlaggedLineRow } from '../components/lists/FlaggedLineRow'
import { Button } from '../components/core/Button'
import { Icon } from '../components/core/Icon'
import { AsyncStatus } from '../components/core/AsyncStatus'
import { describeNeighbours, findSceneNeighbours, sceneLabel, type NeighbourRow } from '../utils/sceneNeighbours'
import { toDisplayName } from '../utils/format'
import styles from './WrapUpPage.module.css'

/** Under a minute reads as "0 min", which looks broken for a short drill — and a
 * rehearsal really can be that short. Seconds below the first minute. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`
  return `${Math.round(seconds / 60)} min`
}

/**
 * Reads back the run she just finished.
 *
 * Awaits the save the rehearsal page started before reading, so the summary is
 * *this* run and not the previous one — the write is a transaction with a query
 * per beat, and an unsynchronised read beats it nearly every time.
 *
 * A save that rejects is swallowed rather than thrown: the read below then 404s
 * and the page renders the honest "not saved" state, which is more use to her
 * than a generic error. `null` means no saved rehearsal exists, which is a real
 * outcome — a guest, a drill, or a failed write — not a failure to load.
 */
async function loadSummary(playId: string, act: string, scene: string): Promise<SessionSummary | null> {
  const saved = await pendingSessionSave(playId, act, scene)?.catch(() => null)

  try {
    return await getSessionSummary(playId, act, scene, saved?.sessionId)
  } catch (err) {
    // 404: nothing saved for this scene. 401: rehearsing as a guest, where the
    // schema has nowhere to put a session at all. Both are "no history", and
    // neither is worth an error screen after a scene she just finished.
    if (err instanceof ApiError && (err.status === 404 || err.status === 401)) return null
    throw err
  }
}

export function WrapUpPage() {
  const { playId = '', act = '', scene = '' } = useParams()
  const navigate = useNavigate()

  // Wrapped in an object so "loaded, but nothing was saved" is distinguishable
  // from "still loading" — useAsync reports both as `data === undefined`.
  const { data: result, loading, error } = useAsync(
    () => loadSummary(playId, act, scene).then((summary) => ({ summary })),
    [playId, act, scene],
  )
  const { data: role } = useAsync(() => getSelectedRole(playId), [playId])
  // Asked for with the character so `characterLines` comes back — that field is
  // what separates "the next scene" from "the next scene she's in".
  const { data: scenes } = useAsync(
    () => (role ? getScenesSummary(playId, role.id) : getScenesSummary(playId)),
    [playId, role?.id],
  )

  if (loading || error || !result) {
    return <AsyncStatus loading={loading} error={error} />
  }

  const { summary } = result
  // Only the speeches the coach actually said something about. An empty note is
  // the right answer more often than not (`coaching-plan.md` §4), and a list of
  // blank rows would suggest something failed rather than that a speech went
  // fine.
  const notedSpeeches = summary?.speeches.filter((speech) => speech.note.length > 0) ?? []

  /**
   * Play the speech a flagged beat belongs to, in her own part's voice.
   *
   * The block rather than the beat, because that is the unit Polly renders —
   * asking for a beat would mean a synthesis that exists nowhere and matches no
   * cache key. Hearing the run-up is also what makes the flagged line locatable;
   * a beat with no lead-in is hard to place in a speech you half know.
   *
   * The button existed and did nothing before this: `FlaggedLineRow` has always
   * taken an `onReplay`, and the wrap-up never passed one, so it rendered with
   * `onClick={undefined}`.
   */
  async function replay(blockId: string) {
    if (!role) return
    // Synchronous, before the await, while this click's activation is alive —
    // see utils/audioPlayback.ts for why that ordering is the whole ballgame on
    // iOS Safari.
    unlockPlayback()
    try {
      const { audioUrl } = await getBlockAudio(blockId, role.id)
      await new Promise<void>((resolve) => {
        const session = playUrl(audioUrl, { onEnded: resolve, onError: resolve })
        void session.started.catch(() => resolve())
      })
    } catch (err) {
      // A cue that won't play is not worth interrupting the wrap-up over.
      console.error('Could not replay that line:', err)
    }
  }

  /**
   * The blocks behind the flagged beats, in the order she spoke them.
   *
   * Distinct, because several flagged beats commonly live in one speech and
   * drilling it twice would be busywork.
   */
  const flaggedBlockIds = [...new Set(summary?.flagged.map((beat) => beat.blockId) ?? [])]
  const backParam = encodeURIComponent(`/play/${playId}/wrap-up/${act}/${scene}`)
  const { playRow, roleRow } = describeNeighbours(findSceneNeighbours(scenes ?? [], act, scene))

  function rehearse(next: { act: string; scene: string }) {
    navigate(`/play/${playId}/rehearse/${next.act}/${next.scene}`)
  }

  /** One prev/next pair. Both sides are always rendered so "next" stays put on
   * the right rather than sliding left when there's no previous — the end of a
   * part shouldn't rearrange the controls she just used. */
  function neighbourRow(row: NeighbourRow, label?: string) {
    return (
      <div className={styles.neighbourRow}>
        {label && <span className={styles.neighbourLabel}>{label}</span>}
        <div className={styles.neighbourButtons}>
          {row.previous ? (
            <button type="button" className={styles.neighbour} onClick={() => rehearse(row.previous!)}>
              <Icon name="chevron-left" size={16} />
              {sceneLabel(row.previous)}
            </button>
          ) : (
            <span className={styles.neighbourEmpty} />
          )}
          {row.next ? (
            <button type="button" className={styles.neighbour} onClick={() => rehearse(row.next!)}>
              {sceneLabel(row.next)}
              <Icon name="chevron-right" size={16} />
            </button>
          ) : (
            <span className={styles.neighbourEmpty} />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.wrap}>
      <h1 className="bh-h1">Nice work.</h1>
      <p className={styles.subhead}>
        Act {act}, Scene {scene} — here's how the run went.
      </p>
      {/* No stats rather than invented ones. This screen showed a fixed 6 min and
          a fixture's flagged lines for every run until the summary became real;
          showing nothing when nothing was recorded is the point of the change. */}
      {summary ? (
        <>
          <div className={styles.stats}>
            <StatCard value={formatDuration(summary.durationSeconds)} label="Duration" />
            {/* Null means the session predates the beats_run column, not that she
                ran no beats — an em dash says "unrecorded", 0 would be a claim. */}
            <StatCard value={summary.beatsRun ?? '—'} label="Beats run" />
            {/* What she set out to run against what she got through. A scene run
                and a four-speech drill are the same two numbers, which is the
                point of a session being a set of blocks (migration 008). */}
            <StatCard
              value={`${summary.blocksRun}/${summary.blocksPlanned}`}
              label="Speeches run"
            />
            <StatCard value={summary.flagged.length} label="Worth another look" tone="terracotta" />
          </div>
          {/* Said plainly rather than left to be inferred from the fraction
              above. Stopping early is a normal way to rehearse and no longer
              loses anything, so this states the fact without framing it as a
              failure. */}
          {summary.completedAt === null && summary.blocksRun < summary.blocksPlanned && (
            <p className={styles.partial}>
              You stopped after {summary.blocksRun} of your {summary.blocksPlanned} speeches
              — everything you ran is saved.
            </p>
          )}
          {notedSpeeches.length > 0 && (
            <>
              <div className={`bh-eyebrow ${styles.sectionLabel}`}>From the wings</div>
              <div className={styles.notes}>
                {notedSpeeches.map((speech) => {
                  const flaggedHere = summary.flagged.filter(
                    (beat) => beat.blockId === speech.blockId,
                  ).length
                  return (
                    <div key={speech.blockId} className={styles.note}>
                      <p className={styles.noteText}>{speech.note}</p>
                      {/* A count rather than a band. The two cuts that turn a
                          confidence into solid/close/dry are still unset, and
                          this number is already stored and already means
                          exactly one thing. */}
                      {flaggedHere > 0 && (
                        <span className={`bh-meta ${styles.noteMeta}`}>
                          {flaggedHere} {flaggedHere === 1 ? 'beat' : 'beats'} worth another look
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
          {summary.flagged.length > 0 && (
            <>
              <div className={`bh-eyebrow ${styles.sectionLabel}`}>Worth another look</div>
              <div className={styles.flaggedList}>
                {summary.flagged.map((beat, i) => (
                  <FlaggedLineRow
                    key={beat.lineId}
                    text={beat.text}
                    trailing="replay"
                    isLast={i === summary.flagged.length - 1}
                    onReplay={() => void replay(beat.blockId)}
                  />
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        <p className={styles.unsaved}>
          This run wasn't saved, so there's nothing to look back on. Sign in before a
          rehearsal and the Book Holder will remember how it went.
        </p>
      )}
      <div className={styles.actions}>
        <Button
          variant="destructive"
          className={styles.actionButton}
          disabled={!summary || summary.flagged.length === 0}
          onClick={() =>
            summary &&
            // Every flagged speech, not just the first — which is what this
            // button said and did not do. `?blocks=` starts a block-scoped
            // session (migration 008): a session is a set of blocks, and a
            // scene is only one kind of set, so a three-speech drill is a real
            // rehearsal that can be finished rather than a scene abandoned
            // after three speeches.
            navigate(
              `/play/${playId}/rehearse/${act}/${scene}?blocks=${flaggedBlockIds.join(',')}&back=${backParam}`,
            )}
        >
          Practice these lines
        </Button>
        {/* The play, not the shelf. The shelf is the play *picker* — she has not
            finished with this play just because she has finished this scene, and
            the play page is where the scene list and her resume card live. */}
        <Button variant="secondary" className={styles.actionButton} onClick={() => navigate(`/play/${playId}`)}>
          Back to the play
        </Button>
      </div>

      {/* Where to go next. Absent entirely at the end of a one-scene play, or when
          the scene list hasn't loaded — never rendered as an empty shell. */}
      {(playRow || roleRow) && (
        <div className={styles.onward}>
          <div className={`bh-eyebrow ${styles.sectionLabel}`}>Carry on</div>
          {/* Labelled only when both rows exist, since that's the only time they
              say different things (see describeNeighbours). */}
          {playRow && neighbourRow(playRow, roleRow ? 'In the play' : undefined)}
          {roleRow && neighbourRow(roleRow, role ? `${toDisplayName(role.name)}'s scenes` : 'Your scenes')}
        </div>
      )}
    </div>
  )
}
