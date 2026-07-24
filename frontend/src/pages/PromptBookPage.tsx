import { useNavigate } from 'react-router-dom'
import { getPromptBookSummary, FOCUS_PLAY_ID } from '../data/client'
import { useAsync } from '../hooks/useAsync'
import { formatRelativeTime } from '../utils/format'
import { MasteryBar } from '../components/mastery/MasteryBar'
import { FlaggedLineRow } from '../components/lists/FlaggedLineRow'
import styles from './PromptBookPage.module.css'

export function PromptBookPage() {
  const navigate = useNavigate()
  const { data: summary, loading } = useAsync(() => getPromptBookSummary(FOCUS_PLAY_ID), [])

  if (loading || !summary) {
    return <p className="bh-label">Loading…</p>
  }

  return (
    <div className={styles.wrap}>
      <h1 className="bh-h1">Prompt Book</h1>
      <p className={styles.subhead}>
        {summary.playTitle} — {summary.characterName}
      </p>
      <div className={styles.masteryBlock}>
        <MasteryBar mastered={summary.mastered} total={summary.total} size="lg" />
      </div>
      <div className={`bh-eyebrow ${styles.sectionLabel}`}>Needs another look</div>
      <div className={styles.list}>
        {summary.needsAnotherLook.map((line, i) => (
          <FlaggedLineRow
            key={line.lineId}
            text={line.text}
            trailing="chevron"
            location={`Act ${line.act} · Scene ${line.scene}`}
            mistakes={line.mistakeCount}
            last={line.lastPracticedAt ? formatRelativeTime(line.lastPracticedAt) : undefined}
            isLast={i === summary.needsAnotherLook.length - 1}
            onClick={() =>
              navigate(`/play/${summary.playId}/rehearse/${line.act}/${line.scene}?line=${line.lineId}&back=${encodeURIComponent('/prompt-book')}`)
            }
          />
        ))}
      </div>
    </div>
  )
}
