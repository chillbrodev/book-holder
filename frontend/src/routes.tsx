import { Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from './components/layout/AppLayout'
import { ShelfPage } from './pages/ShelfPage'
import { RoleSelectPage } from './pages/RoleSelectPage'
import { ScenePickerPage } from './pages/ScenePickerPage'
import { RehearsalPage } from './pages/RehearsalPage'
import { WrapUpPage } from './pages/WrapUpPage'
import { PromptBookPage } from './pages/PromptBookPage'
import { NotFoundPage } from './pages/NotFoundPage'

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Navigate to="/shelf" replace />} />
        <Route path="/shelf" element={<ShelfPage />} />
        <Route path="/play/:playId/role" element={<RoleSelectPage />} />
        <Route path="/play/:playId/scenes" element={<ScenePickerPage />} />
        <Route path="/play/:playId/rehearse/:act/:scene" element={<RehearsalPage />} />
        <Route path="/play/:playId/wrap-up/:act/:scene" element={<WrapUpPage />} />
        <Route path="/prompt-book" element={<PromptBookPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
