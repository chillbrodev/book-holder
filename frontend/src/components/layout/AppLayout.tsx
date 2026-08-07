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
            {/* data-interactive marks the items that carry an underline. It is on
                the element rather than in a second class so that "is this
                clickable" and "does it reserve an underline" can't drift apart. */}
            <NavLink
              to="/shelf"
              data-interactive
              className={({ isActive }) => cx(styles.headerItem, isActive && styles.navLinkActive)}
            >
              The Shelf
            </NavLink>
            <NavLink
              to="/prompt-book"
              data-interactive
              className={({ isActive }) => cx(styles.headerItem, isActive && styles.navLinkActive)}
            >
              Prompt Book
            </NavLink>
          </nav>
          {/* Opt-in only — rehearsing works fine as a guest. This is the one, low-key
              affordance for "I want this saved," never a gate in front of the app. */}
          {!isCheckingSession && (
            <div className={styles.account}>
              {user ? (
                <>
                  {/* No data-interactive: it isn't a control, so it reserves no
                      underline — and now needs no padding to stay level. */}
                  <span className={styles.headerItem}>Hi, {user.name}</span>
                  <button type="button" data-interactive className={styles.headerItem} onClick={() => void logout()}>
                    Log out
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-interactive
                  className={styles.headerItem}
                  onClick={() => setShowAuthModal(true)}
                >
                  Save Progress
                </button>
              )}
            </div>
          )}
        </div>
      </header>
      {/* The scroll region is this wrapper, not the document — so a page can
          size itself against the viewport and have its own sticky furniture,
          and so the scrollbar tracks the full width rather than the centred
          content column. */}
      <div className={styles.scroll}>
        <main className={styles.main}>
          <Outlet />
        </main>
      </div>
      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
    </div>
  )
}
