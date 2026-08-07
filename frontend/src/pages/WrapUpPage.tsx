import { useNavigate, useParams } from 'react-router-dom'
import { getScenesSummary, getSelectedRole, getWrapUpSummary } from '../data/client'
import { useAsync } from '../hooks/useAsync'
import { StatCard } from '../components/cards/StatCard'
import { FlaggedLineRow } from '../components/lists/FlaggedLineRow'
import { Button } from '../components/core/Button'
import { Icon } from '../components/core/Icon'
import { AsyncStatus } from '../components/core/AsyncStatus'
import { describeNeighbours, findSceneNeighbours, sceneLabel, type NeighbourRow } from '../utils/sceneNeighbours'
import { toDisplayName } from '../utils/format'
import styles from './WrapUpPage.module.css'

function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  return `${minutes} min`
}

export function WrapUpPage() {
  const { playId = '', act = '', scene = '' } = useParams()
  const navigate = useNavigate()

  const { data: summary, loading, error } = useAsync(() => getWrapUpSummary(playId, act, scene), [playId, act, scene])
  const { data: role } = useAsync(() => getSelectedRole(playId), [playId])
  // Asked for with the character so `characterLines` comes back — that field is
  // what separates "the next scene" from "the next scene she's in".
  const { data: scenes } = useAsync(
    () => (role ? getScenesSummary(playId, role.id) : getScenesSummary(playId)),
    [playId, role?.id],
  )

  if (loading || error || !summary) {
    return <AsyncStatus loading={loading} error={error} />
  }

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
      <div className={styles.stats}>
        <StatCard value={formatDuration(summary.durationSeconds)} label="Duration" />
        <StatCard value={summary.linesRun} label="Lines run" />
        <StatCard value={summary.flagged.length} label="Worth another look" tone="terracotta" />
      </div>
      <div className={`bh-eyebrow ${styles.sectionLabel}`}>Worth another look</div>
      <div className={styles.flaggedList}>
        {summary.flagged.map((line, i) => (
          <FlaggedLineRow key={line.lineId} text={line.text} trailing="replay" isLast={i === summary.flagged.length - 1} />
        ))}
      </div>
      <div className={styles.actions}>
        <Button
          variant="destructive"
          className={styles.actionButton}
          disabled={summary.flagged.length === 0}
          onClick={() => navigate(`/play/${playId}/rehearse/${act}/${scene}?line=${summary.flagged[0].lineId}&back=${backParam}`)}
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
