import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { cx } from '../../utils/cx'
import { useAuth } from '../../auth/useAuth'
import { AuthModal } from '../../auth/AuthModal'
import styles from './AppLayout.module.css'

/** Header with wordmark + nav, wraps every page via <Outlet/>. Replaces the prototype's local screen-state switch with real routes. */
export function AppLayout() {
  const { user, isCheckingSession, logout } = useAuth()
  const [showAuthModal, setShowAuthModal] = useState(false)

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <NavLink to="/shelf" className={styles.wordmark}>
          The Book Holder
        </NavLink>
        <div className={styles.headerRight}>
          <nav className={styles.nav}>
            <NavLink to="/shelf" className={({ isActive }) => cx(styles.navLink, isActive && styles.navLinkActive)}>
              The Shelf
            </NavLink>
            <NavLink to="/prompt-book" className={({ isActive }) => cx(styles.navLink, isActive && styles.navLinkActive)}>
              Prompt Book
            </NavLink>
          </nav>
          {/* Opt-in only — rehearsing works fine as a guest. This is the one, low-key
              affordance for "I want this saved," never a gate in front of the app. */}
          {!isCheckingSession && (
            <div className={styles.account}>
              {user ? (
                <>
                  <span className={styles.accountName}>Hi, {user.name}</span>
                  <button type="button" className={styles.accountLink} onClick={() => void logout()}>
                    Log out
                  </button>
                </>
              ) : (
                <button type="button" className={styles.accountLink} onClick={() => setShowAuthModal(true)}>
                  Save Progress
                </button>
              )}
            </div>
          )}
        </div>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
    </div>
  )
}
