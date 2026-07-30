import { useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { getCharacters, getLastScene, getPlay, getScenesSummary, getSelectedRole, selectRole } from '../data/client'
import { useAsync } from '../hooks/useAsync'
import { CharacterTile } from '../components/cards/CharacterTile'
import { SceneList } from '../components/lists/SceneList'
import { FilterTabs } from '../components/navigation/FilterTabs'
import { AsyncStatus } from '../components/core/AsyncStatus'
import { Button } from '../components/core/Button'
import { Icon } from '../components/core/Icon'
import { pluralize, toDisplayName } from '../utils/format'
import type { SceneSummary } from '../types/views'
import styles from './PlayPage.module.css'

/**
 * Everything between picking a play and starting a scene, under one centred
 * title — but as two separate steps, not one long page. Choosing a part and
 * choosing a scene are different decisions, and stacking them meant the scene
 * list appeared under your feet the moment you tapped a name.
 *
 * The step lives in the URL (`?step=role|scene`) rather than in component
 * state so browser Back steps between them instead of leaving for the shelf —
 * which is what someone reaching for Back after mis-tapping a part expects.
 *
 * With nowhere to resume, or arriving from the rehearsal screen's change
 * links, it opens straight at the relevant step.
 */
export function PlayPage() {
  const { playId = '' } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const step = searchParams.get('step')

  const { data: play, loading: playLoading, error: playError } = useAsync(() => getPlay(playId), [playId])
  const { data: characters, loading: charactersLoading, error: charactersError } = useAsync(
    () => getCharacters(playId),
    [playId],
  )
  const { data: existingRole, loading: roleLoading, error: roleError } = useAsync(() => getSelectedRole(playId), [playId])
  const { data: lastScene, loading: lastSceneLoading } = useAsync(() => getLastScene(playId), [playId])

  // Highlighted but not yet committed — the part is only saved on Continue, so
  // backing out of step one leaves the previously chosen part untouched.
  const [pickedRoleId, setPickedRoleId] = useState<string | null>(null)
  const [showAllScenes, setShowAllScenes] = useState(false)

  // Scenes are fetched per character so each row can say how much of it is
  // hers. Keyed on the role id, so choosing a different part refetches — and
  // because useAsync clears data while refetching, the page falls back to its
  // loading state rather than briefly showing counts for the previous part.
  const roleIdForScenes = pickedRoleId ?? existingRole?.id
  const { data: scenes, loading: scenesLoading, error: scenesError } = useAsync(
    () => getScenesSummary(playId, roleIdForScenes),
    [playId, roleIdForScenes],
  )

  const loading = playLoading || charactersLoading || scenesLoading || roleLoading || lastSceneLoading
  const error = playError ?? charactersError ?? scenesError ?? roleError
  if (loading || error || !play || !characters || !scenes) {
    return <AsyncStatus loading={loading} error={error} />
  }

  // Synthetic characters (e.g. "All", the group-speaker for unison lines —
  // see PROJECT_PLAN.md §6 parsing rule 5) aren't someone you can rehearse as.
  const selectableCharacters = characters.filter((c) => !c.isSynthetic)
  const selected = selectableCharacters.find((c) => c.id === (pickedRoleId ?? existingRole?.id))

  // A part alone isn't a session — she may have chosen one and never started.
  // Both halves have to be present before offering to resume.
  const canResume = existingRole != null && lastScene != null
  // Scenes the part actually appears in. For a 12-line role that's 1 row out
  // of 23 — the whole reason the filter exists.
  const scenesWithRole = scenes.filter((scene) => (scene.characterLines ?? 0) > 0)

  // Landing with no step named: resume if there's somewhere to resume to,
  // otherwise start at step one.
  //
  // Naming a step always skips the resume cards, even when the step can't be
  // honoured — asking for the scene list with an unusable saved part (a stale
  // id after a re-import, or one pointing at a synthetic character) should
  // land on step one, not silently on a resume card she didn't ask for.
  const namedStep = step === 'role' || step === 'scene'
  const view = step === 'scene' && selected ? 'scene' : namedStep || !canResume ? 'role' : 'resume'

  function goToStep(next: 'role' | 'scene') {
    navigate(`/play/${playId}?step=${next}`)
  }

  function handleContinueFromRole() {
    if (!selected) return
    void selectRole(playId, selected.id)
    goToStep('scene')
  }

  function handlePickScene(scene: SceneSummary) {
    navigate(`/play/${playId}/rehearse/${scene.act}/${scene.scene}`)
  }

  return (
    <div className={styles.wrap}>
      <h1 className={`bh-display ${styles.title}`}>{play.title}</h1>

      {/* lastScene/existingRole are restated rather than relied on via
          canResume — `view` is a string, so narrowing doesn't carry through it. */}
      {view === 'resume' && lastScene && existingRole && (
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

          <button type="button" className={styles.card} onClick={() => goToStep('role')}>
            <span className="bh-eyebrow">Start a new run</span>
            <span className={styles.cardTitle}>Read a different part</span>
            <span className={styles.cardBody}>Pick another role and choose a scene to work on.</span>
            <span className={styles.cardAction}>
              Choose a part <Icon name="chevron-right" size={18} />
            </span>
          </button>
        </div>
      )}

      {view === 'role' && (
        <section>
          <div className={`bh-eyebrow ${styles.stepLabel}`}>Step 1 of 2</div>
          <h2 className={`bh-h2 ${styles.stepTitle}`}>Who are you reading?</h2>
          <p className={styles.stepHint}>
            {existingRole
              ? `Last time you read ${toDisplayName(existingRole.name)}. Carry on, or pick a different part.`
              : 'The lines and scenes under each name tell you how big the part is.'}
          </p>
          <div className={styles.grid}>
            {selectableCharacters.map((character) => (
              <CharacterTile
                key={character.id}
                name={toDisplayName(character.name)}
                lineCount={character.lineCount}
                sceneCount={character.sceneCount}
                selected={selected?.id === character.id}
                onClick={() => setPickedRoleId(character.id)}
              />
            ))}
          </div>
          {/* A confirm step rather than advancing on tap: a mis-tap here would
              otherwise change the part and move the page in one go. */}
          <div className={styles.stepActions}>
            <Button variant="primary" disabled={!selected} onClick={handleContinueFromRole} className={styles.stepButton}>
              {selected ? `Continue as ${toDisplayName(selected.name)}` : 'Pick a part to continue'}
            </Button>
          </div>
        </section>
      )}

      {view === 'scene' && selected && (
        <section>
          <div className={`bh-eyebrow ${styles.stepLabel}`}>Step 2 of 2</div>
          <h2 className={`bh-h2 ${styles.stepTitle}`}>Where do you want to start?</h2>
          <p className={styles.stepHint}>
            Reading {toDisplayName(selected.name)} · {pluralize(selected.lineCount, 'line')} across{' '}
            {pluralize(selected.sceneCount, 'scene')}.{' '}
            <button type="button" className={styles.inlineLink} onClick={() => goToStep('role')}>
              Change part
            </button>
          </p>
          {/* Only worth offering when it filters something out — a part in
              every scene would get two tabs showing the same list. */}
          {scenesWithRole.length < scenes.length && (
            <div className={styles.sceneFilter}>
              <FilterTabs
                options={[`${toDisplayName(selected.name)}'s scenes`, 'All scenes']}
                value={showAllScenes ? 'All scenes' : `${toDisplayName(selected.name)}'s scenes`}
                onChange={(value) => setShowAllScenes(value === 'All scenes')}
              />
            </div>
          )}
          <SceneList scenes={showAllScenes ? scenes : scenesWithRole} onSelect={handlePickScene} />
        </section>
      )}
    </div>
  )
}
