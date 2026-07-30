import { groupScenesByAct } from '../../utils/format'
import { SceneRow } from './SceneRow'
import type { SceneSummary } from '../../types/views'
import styles from './SceneList.module.css'

export interface SceneListProps {
  scenes: SceneSummary[]
  onSelect: (scene: SceneSummary) => void
}

/** Act-grouped scene rows — lifted out of the old scene-picker page so the
 * play page can show it inline underneath the role grid. */
export function SceneList({ scenes, onSelect }: SceneListProps) {
  return (
    <>
      {groupScenesByAct(scenes).map((group) => (
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
                yourLines={scene.characterLines}
                current={scene.isCurrent}
                onClick={() => onSelect(scene)}
                isLast={i === group.scenes.length - 1}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  )
}
