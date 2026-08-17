import { BrowserRouter } from 'react-router-dom'
import { AppRoutes } from './routes'
import { AuthProvider } from './auth/AuthProvider'
import { useAuth } from './auth/useAuth'

/**
 * Remounts every screen when she signs out.
 *
 * Clearing her stored part and place is only half of leaving; without this the
 * play page keeps rendering the "Pick up where you left off" card it had already
 * loaded, because its fetches are keyed on the play and nothing about the play
 * changed. Keying the tree on `resetKey` makes leaving a genuine reset — every
 * page re-fetches, and anything auth-gated comes back as a guest would see it.
 *
 * Inside AuthProvider because it needs the context, and keyed on `resetKey`
 * rather than the user id on purpose — see the note on `resetKey` for why
 * signing *in* must not remount anything.
 */
function IdentityScopedRoutes() {
  const { resetKey } = useAuth()
  return <AppRoutes key={resetKey} />
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <IdentityScopedRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}
