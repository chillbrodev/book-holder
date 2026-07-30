import { useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { getCharacters, getLastScene, getPlay, getScenesSummary, getSelectedRole, selectRole } from '../data/client'
import { useAsync } from '../hooks/useAsync'
import { CharacterTile } from '../components/cards/CharacterTile'
import { SceneList } from '../components/lists/SceneList'
import { AsyncStatus } from '../components/core/AsyncStatus'
import { Icon } from '../components/core/Icon'
import { pluralize, toDisplayName } from '../utils/format'
import type { SceneSummary } from '../types/views'
import styles from './PlayPage.module.css'

/**
 * Everything between picking a play and starting a scene, on one page under
 * one centred title — replaces the separate role-picker and scene-picker
 * routes, which split the decision across two screens and never said which
 * play you were in.
 *
 * Two states:
 *  - Somewhere to resume (a saved part *and* a saved place) — two cards,
 *    carry on or start over. Nothing else competing for attention.
 *  - Otherwise — the part grid, then the scene list once a part is chosen.
 */
export function PlayPage() {
  const { playId = '' } = useParams()
  const navigate = useNavigate()
  // `?change=scene|role` arrives from the rehearsal screen's change links —
  // she's already mid-run and knows where she is, so the resume card would
  // just be one more tap in the way of the picker she asked for.
  const [searchParams] = useSearchParams()
  const arrivedToChange = searchParams.get('change') != null

  const { data: play, loading: playLoading, error: playError } = useAsync(() => getPlay(playId), [playId])
  const { data: characters, loading: charactersLoading, error: charactersError } = useAsync(
    () => getCharacters(playId),
    [playId],
  )
  const { data: scenes, loading: scenesLoading, error: scenesError } = useAsync(() => getScenesSummary(playId), [playId])
  const { data: existingRole, loading: roleLoading, error: roleError } = useAsync(() => getSelectedRole(playId), [playId])
  const { data: lastScene, loading: lastSceneLoading } = useAsync(() => getLastScene(playId), [playId])

  // Set when she chooses "start a new run" from the resume card — keeps her on
  // this page in setup mode rather than routing somewhere else to do the same job.
  const [startingOver, setStartingOver] = useState(arrivedToChange)
  const [pickedRoleId, setPickedRoleId] = useState<string | null>(null)

  const loading = playLoading || charactersLoading || scenesLoading || roleLoading || lastSceneLoading
  const error = playError ?? charactersError ?? scenesError ?? roleError
  if (loading || error || !play || !characters || !scenes) {
    return <AsyncStatus loading={loading} error={error} />
  }

  // Synthetic characters (e.g. "All", the group-speaker for unison lines —
  // see PROJECT_PLAN.md §6 parsing rule 5) aren't someone you can rehearse as.
  const selectableCharacters = characters.filter((c) => !c.isSynthetic)

  // A part alone isn't a session — she may have chosen one and never started.
  // Both halves have to be present before offering to resume.
  const canResume = existingRole != null && lastScene != null && !startingOver
  const activeRoleId = pickedRoleId ?? existingRole?.id ?? null
  const activeRole = selectableCharacters.find((c) => c.id === activeRoleId)

  function handlePickRole(characterId: string) {
    setPickedRoleId(characterId)
    // Persisted immediately rather than on scene click — leaving now and
    // coming back should remember the part, same as before.
    void selectRole(playId, characterId)
  }

  function handlePickScene(scene: SceneSummary) {
    navigate(`/play/${playId}/rehearse/${scene.act}/${scene.scene}`)
  }

  return (
    <div className={styles.wrap}>
      <h1 className={`bh-display ${styles.title}`}>{play.title}</h1>

      {canResume ? (
        <div className={styles.cards}>
          <button
            type="button"
            className={`${styles.card} ${styles.resumeCard}`}
            onClick={() => navigate(`/play/${playId}/rehearse/${lastScene.act}/${lastScene.scene}`)}
          >
            <span className="bh-eyebrow">Pick up where you left off</span>
            <span className={styles.cardTitle}>
              Act {lastScene.act}, Scene {lastScene.scene}
            </span>
            <span className={styles.cardBody}>as {toDisplayName(existingRole.name)}</span>
            <span className={styles.cardAction}>
              Resume rehearsal <Icon name="chevron-right" size={18} />
            </span>
          </button>

          <button type="button" className={styles.card} onClick={() => setStartingOver(true)}>
            <span className="bh-eyebrow">Start a new run</span>
            <span className={styles.cardTitle}>Read a different part</span>
            <span className={styles.cardBody}>Pick another role and choose a scene to work on.</span>
            <span className={styles.cardAction}>
              Choose a part <Icon name="chevron-right" size={18} />
            </span>
          </button>
        </div>
      ) : (
        <>
          <section className={styles.section}>
            <h2 className={`bh-h2 ${styles.sectionTitle}`}>Who are you reading?</h2>
            <p className={styles.sectionHint}>
              {activeRole
                ? `Reading ${toDisplayName(activeRole.name)}. Pick a different part if you'd rather.`
                : 'Pick your part — the number of lines and scenes tells you how big it is.'}
            </p>
            <div className={styles.grid}>
              {selectableCharacters.map((character) => (
                <CharacterTile
                  key={character.id}
                  name={toDisplayName(character.name)}
                  lineCount={character.lineCount}
                  sceneCount={character.sceneCount}
                  selected={activeRoleId === character.id}
                  onClick={() => handlePickRole(character.id)}
                />
              ))}
            </div>
          </section>

          {activeRole && (
            <section className={styles.section}>
              <h2 className={`bh-h2 ${styles.sectionTitle}`}>Where do you want to start?</h2>
              <p className={styles.sectionHint}>
                {activeRole.sceneCount > 0
                  ? `${toDisplayName(activeRole.name)} appears in ${pluralize(activeRole.sceneCount, 'scene')}. Pick any scene to run.`
                  : 'Pick any scene to run.'}
              </p>
              <SceneList scenes={scenes} onSelect={handlePickScene} />
            </section>
          )}
        </>
      )}
    </div>
  )
}
