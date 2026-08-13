import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '../components/core/Button'
import { useAuth } from './useAuth'
import { AuthApiError } from './authClient'
import { PinInput } from './PinInput'
import styles from './AuthModal.module.css'

export interface AuthModalProps {
  onClose: () => void
}

type Mode = 'register' | 'login'

const COPY: Record<Mode, { title: string; subhead: string; submitLabel: string; toggleLabel: string }> = {
  register: {
    title: 'Save Your Progress',
    subhead: "Choose a username and a PIN, and next time you'll pick up right where you left off.",
    submitLabel: 'Save My Progress',
    toggleLabel: 'Already have an account? Log in',
  },
  login: {
    title: 'Welcome Back',
    subhead: 'Enter your username and PIN to get back to your rehearsal.',
    submitLabel: 'Log In',
    toggleLabel: "Don't have an account? Save your progress",
  },
}

/** Opt-in only, never mounted on load, only in response to her clicking
 * "Save Progress." Rehearsing without an account works fine; this is purely
 * for the "I want this to still be here next time" case. */
export function AuthModal({ onClose }: AuthModalProps) {
  const { register, login } = useAuth()
  const [mode, setMode] = useState<Mode>('register')
  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  const pinsMismatched = mode === 'register' && confirmPin.length > 0 && pin !== confirmPin

  useEffect(() => {
    firstFieldRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function toggleMode() {
    setMode((current) => (current === 'register' ? 'login' : 'register'))
    setConfirmPin('')
    setError(null)
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)

    if (mode === 'register' && pin !== confirmPin) {
      setError("Those PINs don't match. Try entering them again.")
      return
    }

    setSubmitting(true)
    try {
      if (mode === 'register') {
        await register(username, pin)
      } else {
        await login(username, pin)
      }
      onClose()
    } catch (err) {
      setError(err instanceof AuthApiError ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const copy = COPY[mode]

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
          &times;
        </button>

        <h2 id="auth-modal-title" className="bh-h2">
          {copy.title}
        </h2>
        <p className={styles.subhead}>{copy.subhead}</p>

        <form onSubmit={handleSubmit} className={styles.form}>
          <label className={styles.field}>
            <span className={styles.label}>Username</span>
            <input
              ref={firstFieldRef}
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
            />
          </label>

          <PinInput
            label="PIN (4–8 digits)"
            value={pin}
            onChange={setPin}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          />

          {mode === 'register' && (
            <>
              <PinInput label="Confirm PIN" value={confirmPin} onChange={setConfirmPin} autoComplete="new-password" />
              {pinsMismatched && <p className={styles.hint}>PINs don't match yet.</p>}
            </>
          )}

          {error && <p className={styles.error}>{error}</p>}

          <Button type="submit" disabled={submitting || pinsMismatched} className={styles.submit}>
            {submitting ? 'One moment…' : copy.submitLabel}
          </Button>
        </form>

        <button type="button" className={styles.toggle} onClick={toggleMode}>
          {copy.toggleLabel}
        </button>
      </div>
    </div>
  )
}
