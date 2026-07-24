import { useEffect } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { getScenesSummary, getSelectedRole } from '../data/client'
import { useAsync } from '../hooks/useAsync'
import { groupScenesByAct } from '../utils/format'
import { MasteryBar } from '../components/mastery/MasteryBar'
import { SceneRow } from '../components/lists/SceneRow'
import styles from './ScenePickerPage.module.css'

export function ScenePickerPage() {
  const { playId = '' } = useParams()
  const navigate = useNavigate()

  const { data: character, loading: roleLoading } = useAsync(() => getSelectedRole(playId), [playId])
  const { data: scenes, loading: scenesLoading } = useAsync(() => getScenesSummary(playId), [playId])

  useEffect(() => {
    if (!roleLoading && !character) {
      navigate(`/play/${playId}/role`, { replace: true })
    }
  }, [roleLoading, character, playId, navigate])

  if (roleLoading || scenesLoading || !character || !scenes) {
    return <p className="bh-label">Loading…</p>
  }

  const current = scenes.find((scene) => scene.isCurrent) ?? scenes[0]
  const grouped = groupScenesByAct(scenes)

  return (
    <div>
      <Link to="/shelf" className={styles.backLink}>
        ← Back to the shelf
      </Link>
      <div className={styles.titleRow}>
        <h1 className="bh-h1">The Merry Wives of Windsor</h1>
        <Link
          to={`/play/${playId}/role`}
          className={styles.identityPill}
          aria-label={`Rehearsing as ${character.name}. Tap to change role.`}
        >
          <span className={styles.identityLabel}>Rehearsing as {character.name}</span>
          <span className={styles.changeHint} aria-hidden="true">
            Tap to change role
          </span>
        </Link>
      </div>

      {current && (
        <Link to={`/play/${playId}/rehearse/${current.act}/${current.scene}`} className={styles.continueCard}>
          <div className="bh-eyebrow">Continue</div>
          <div className={styles.continueTitle}>
            Act {current.act}, {current.title}
          </div>
          {current.description && <div className={styles.continueDescription}>{current.description}</div>}
          <div className={styles.continueMastery}>
            <MasteryBar mastered={current.mastered} total={current.total} />
          </div>
        </Link>
      )}

      {grouped.map((group) => (
        <div key={group.act} className={styles.actGroup}>
          <div className={`bh-eyebrow ${styles.actLabel}`}>Act {group.act}</div>
          <div className={styles.sceneList}>
            {group.scenes.map((scene, i) => (
              <SceneRow
                key={`${scene.act}-${scene.scene}`}
                title={scene.title}
                description={scene.description}
                mastered={scene.mastered}
                total={scene.total}
                current={scene.isCurrent}
                onClick={scene.isCurrent ? () => navigate(`/play/${playId}/rehearse/${scene.act}/${scene.scene}`) : undefined}
                isLast={i === group.scenes.length - 1}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
