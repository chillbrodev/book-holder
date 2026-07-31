import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { AppLayout } from './components/layout/AppLayout'
import { ShelfPage } from './pages/ShelfPage'
import { PlayPage } from './pages/PlayPage'
import { RehearsalPage } from './pages/RehearsalPage'
import { WrapUpPage } from './pages/WrapUpPage'
import { PromptBookPage } from './pages/PromptBookPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { BlockPreviewPage } from './pages/BlockPreviewPage'

/** The separate role and scene pickers are one page now — anything still
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
        {/* Local-only: beats-and-blocks rendering driven by importer fixtures,
            no API or Polly. Remove once RehearsalPage renders blocks for real. */}
        <Route path="/preview/blocks" element={<BlockPreviewPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
