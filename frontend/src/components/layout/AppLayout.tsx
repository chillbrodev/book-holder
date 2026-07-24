import { NavLink, Outlet } from 'react-router-dom'
import { cx } from '../../utils/cx'
import styles from './AppLayout.module.css'

/** Header with wordmark + nav, wraps every page via <Outlet/>. Replaces the prototype's local screen-state switch with real routes. */
export function AppLayout() {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <NavLink to="/shelf" className={styles.wordmark}>
          The Book Holder
        </NavLink>
        <nav className={styles.nav}>
          <NavLink to="/shelf" className={({ isActive }) => cx(styles.navLink, isActive && styles.navLinkActive)}>
            The Shelf
          </NavLink>
          <NavLink to="/prompt-book" className={({ isActive }) => cx(styles.navLink, isActive && styles.navLinkActive)}>
            Prompt Book
          </NavLink>
        </nav>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  )
}
