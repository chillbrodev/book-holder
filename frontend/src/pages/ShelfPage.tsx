import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getPlays } from '../data/client'
import { useAsync } from '../hooks/useAsync'
import { PlayCard } from '../components/cards/PlayCard'
import { FilterTabs } from '../components/navigation/FilterTabs'
import styles from './ShelfPage.module.css'

const FILTERS = ['All', 'Favorites', 'In progress']

export function ShelfPage() {
  const navigate = useNavigate()
  const [filter, setFilter] = useState('All')
  const { data: plays, loading } = useAsync(() => getPlays(), [])

  if (loading || !plays) {
    return <p className="bh-label">Loading…</p>
  }

  const visible = plays.filter((play) => {
    if (filter === 'Favorites') return play.favorite
    if (filter === 'In progress') return play.status === 'inProgress' || play.status === 'focus'
    return true
  })

  return (
    <div>
      <h1 className="bh-display">The Shelf</h1>
      <p className={styles.subhead}>Pick a play. She's rehearsing one for real — the rest are on their way.</p>
      <div className={styles.tabsRow}>
        <FilterTabs options={FILTERS} value={filter} onChange={setFilter} />
      </div>
      <div className={styles.grid}>
        {visible.map((play) => (
          <PlayCard
            key={play.id}
            title={play.title}
            status={play.status}
            locked={play.locked}
            favorite={play.favorite}
            mastered={play.mastery?.mastered ?? 0}
            total={play.mastery?.total ?? 0}
            onClick={play.locked ? undefined : () => navigate(`/play/${play.id}/scenes`)}
          />
        ))}
      </div>
    </div>
  )
}
