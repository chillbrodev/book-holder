import { useNavigate, useParams } from 'react-router-dom'
import { getWrapUpSummary } from '../data/client'
import { useAsync } from '../hooks/useAsync'
import { StatCard } from '../components/cards/StatCard'
import { FlaggedLineRow } from '../components/lists/FlaggedLineRow'
import { Button } from '../components/core/Button'
import styles from './WrapUpPage.module.css'

function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  return `${minutes} min`
}

export function WrapUpPage() {
  const { playId = '', act = '', scene = '' } = useParams()
  const navigate = useNavigate()

  const { data: summary, loading } = useAsync(() => getWrapUpSummary(playId, act, scene), [playId, act, scene])

  if (loading || !summary) {
    return <p className="bh-label">Loading…</p>
  }

  const backParam = encodeURIComponent(`/play/${playId}/wrap-up/${act}/${scene}`)

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
        <Button variant="secondary" className={styles.actionButton} onClick={() => navigate('/shelf')}>
          Back to the shelf
        </Button>
      </div>
    </div>
  )
}
