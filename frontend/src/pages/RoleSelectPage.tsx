import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { getCharacters, getSelectedRole, selectRole } from '../data/client'
import { useAsync } from '../hooks/useAsync'
import { CharacterRow } from '../components/lists/CharacterRow'
import { Button } from '../components/core/Button'
import styles from './RoleSelectPage.module.css'

export function RoleSelectPage() {
  const { playId = '' } = useParams()
  const navigate = useNavigate()
  const [selected, setSelected] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const { data: existingRole, loading: roleLoading } = useAsync(() => getSelectedRole(playId), [playId])
  const { data: characters, loading: charactersLoading } = useAsync(() => getCharacters(playId), [playId])

  // Pre-select the current role when changing roles, so the picker opens showing where you already are.
  useEffect(() => {
    if (existingRole && selected === null) {
      setSelected(existingRole.id)
    }
  }, [existingRole, selected])

  async function handleConfirm() {
    if (!selected) return
    setConfirming(true)
    await selectRole(playId, selected)
    navigate(`/play/${playId}/scenes`)
  }

  if (roleLoading || charactersLoading || !characters) {
    return <p className="bh-label">Loading…</p>
  }

  const selectedCharacter = characters.find((c) => c.id === selected)
  const backHref = existingRole ? `/play/${playId}/scenes` : '/shelf'
  const backLabel = existingRole ? '← Back to the scene picker' : '← Back to the shelf'

  return (
    <div className={styles.wrap}>
      <Link to={backHref} className={styles.backLink}>
        {backLabel}
      </Link>
      <h1 className={`bh-h1 ${styles.title}`}>Who are you reading?</h1>
      <p className={styles.subhead}>
        {existingRole
          ? 'Pick a different part — you can switch back anytime from the scene picker.'
          : "You can change who you're reading anytime from the scene picker."}
      </p>
      <div className={styles.list}>
        {characters.map((character, i) => (
          <CharacterRow
            key={character.id}
            name={character.name}
            selected={selected === character.id}
            onClick={() => setSelected(character.id)}
            isLast={i === characters.length - 1}
          />
        ))}
      </div>
      <div className={styles.confirmRow}>
        <Button variant="primary" disabled={!selected || confirming} onClick={handleConfirm} className={styles.confirmButton}>
          {selectedCharacter ? `Start rehearsing as ${selectedCharacter.name}` : 'Pick a character to continue'}
        </Button>
      </div>
    </div>
  )
}
