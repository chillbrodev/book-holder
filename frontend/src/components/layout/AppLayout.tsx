import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { cx } from '../../utils/cx'
import { useAuth } from '../../auth/useAuth'
import { AuthModal } from '../../auth/AuthModal'
import { isPlaybackUnlocked, unlockPlayback } from '../../utils/audioPlayback'
import styles from './AppLayout.module.css'

/** Header with wordmark + nav, wraps every page via <Outlet/>. Replaces the prototype's local screen-state switch with real routes. */
export function AppLayout() {
  const { user, isCheckingSession, logout } = useAuth()
  const [showAuthModal, setShowAuthModal] = useState(false)
  // "Log out" was the widest thing in the header after the wordmark and was on
  // screen permanently to serve an action taken about once. It now lives behind
  // the name, which is where a signed-in user looks for it anyway.
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const accountRef = useRef<HTMLDivElement>(null)
  const accountTriggerRef = useRef<HTMLButtonElement>(null)

  // Spend the very first tap anywhere in the app on unlocking audio playback.
  //
  // It lives up here rather than on the rehearsal screen because by the time
  // that screen mounts it is already too late: she arrives by tapping "Resume
  // rehearsal" on the previous page, and the reading starts on its own with no
  // further tap to borrow. Registering here means the tap that begins the
  // journey is the one that pays for it, and the rehearsal screen finds
  // playback already unlocked. See utils/audioPlayback.ts for what iOS Safari
  // actually requires and why one element is shared.
  //
  // Not `once: true`; the first tap can land while the page is still settling,
  // and an unlock that fails has to be retryable. unlockPlayback() returns
  // immediately once it has succeeded, so the listener costs nothing after that.
  useEffect(() => {
    const onGesture = () => {
      unlockPlayback()
      if (isPlaybackUnlocked()) document.removeEventListener('pointerdown', onGesture)
    }
    document.addEventListener('pointerdown', onGesture)
    return () => document.removeEventListener('pointerdown', onGesture)
  }, [])

  // Dismissal. `pointerdown` rather than `click` so the menu closes on press
  // rather than release, a click listener lets the menu sit open under a
  // finger already on its way somewhere else, and on touch that reads as lag.
  useEffect(() => {
    if (!accountMenuOpen) return

    const onPointerDown = (event: PointerEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setAccountMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setAccountMenuOpen(false)
      // Focus goes back to what opened the menu, or it would fall to the top of
      // the document and a keyboard user would have to tab in from the start.
      accountTriggerRef.current?.focus()
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [accountMenuOpen])

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
            <div className={styles.account} ref={accountRef}>
              {user ? (
                <>
                  {/* Now genuinely a control, so it takes data-interactive and
                      the underline that goes with it — and unlike the nav, it
                      carries that underline at rest rather than on hover. A
                      phone has no hover, and without it the name reads as the
                      label it used to be, with nothing to say the only way to
                      sign out is through it. */}
                  <button
                    type="button"
                    data-interactive
                    ref={accountTriggerRef}
                    className={cx(styles.headerItem, styles.accountTrigger)}
                    onClick={() => setAccountMenuOpen((open) => !open)}
                    aria-haspopup="menu"
                    aria-expanded={accountMenuOpen}
                  >
                    Hi, {user.name}
                  </button>
                  {accountMenuOpen && (
                    <div className={styles.accountMenu} role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.accountMenuItem}
                        onClick={() => {
                          setAccountMenuOpen(false)
                          void logout()
                        }}
                      >
                        Log out
                      </button>
                    </div>
                  )}
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
