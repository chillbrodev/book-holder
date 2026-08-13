import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { AppLayout } from './components/layout/AppLayout'
import { ShelfPage } from './pages/ShelfPage'
import { PlayPage } from './pages/PlayPage'
import { RehearsalPage } from './pages/RehearsalPage'
import { WrapUpPage } from './pages/WrapUpPage'
import { PromptBookPage } from './pages/PromptBookPage'
import { NotFoundPage } from './pages/NotFoundPage'

/** The separate role and scene pickers are one page now, anything still
 * pointing at the old URLs (a bookmark, the browser's back stack, the
 * wrap-up's ?back= param) lands on it instead of 404ing. */
function RedirectToPlay() {
  const { playId = '' } = useParams()
  return <Navigate to={`/play/${playId}`} replace />
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Navigate to="/shelf" replace />} />
        <Route path="/shelf" element={<ShelfPage />} />
        <Route path="/play/:playId" element={<PlayPage />} />
        <Route path="/play/:playId/role" element={<RedirectToPlay />} />
        <Route path="/play/:playId/scenes" element={<RedirectToPlay />} />
        <Route path="/play/:playId/rehearse/:act/:scene" element={<RehearsalPage />} />
        <Route path="/play/:playId/wrap-up/:act/:scene" element={<WrapUpPage />} />
        <Route path="/prompt-book" element={<PromptBookPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
