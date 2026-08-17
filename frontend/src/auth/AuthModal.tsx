import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '../components/core/Button'
import { useAuth } from './useAuth'
import { AuthApiError } from './authClient'
import { PasswordInput } from './PasswordInput'
import styles from './AuthModal.module.css'

export interface AuthModalProps {
  onClose: () => void
}

type Mode = 'register' | 'login'

const COPY: Record<Mode, { title: string; subhead: string; submitLabel: string; toggleLabel: string }> = {
  register: {
    title: 'Save Your Progress',
    subhead: "Sign up with your email, and next time you'll pick up right where you left off.",
    submitLabel: 'Save My Progress',
    toggleLabel: 'Already have an account? Log in',
  },
  login: {
    title: 'Welcome Back',
    subhead: 'Enter your email and password to get back to your rehearsal.',
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
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  // The one non-error, non-signed-in outcome: the account exists and Supabase
  // has sent a confirmation link. Closing the modal on that would look exactly
  // like a successful sign-in and leave her a guest with no explanation.
  const [confirmationSentTo, setConfirmationSentTo] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  const passwordsMismatched =
    mode === 'register' && confirmPassword.length > 0 && password !== confirmPassword

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
    setConfirmPassword('')
    setError(null)
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)

    if (mode === 'register' && password !== confirmPassword) {
      setError("Those passwords don't match. Try entering them again.")
      return
    }

    setSubmitting(true)
    try {
      if (mode === 'register') {
        const { signedIn } = await register(email, password)
        if (!signedIn) {
          setConfirmationSentTo(email)
          return
        }
      } else {
        await login(email, password)
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

        {confirmationSentTo ? (
          <>
            <h2 id="auth-modal-title" className="bh-h2">
              Check Your Inbox
            </h2>
            <p className={styles.subhead}>
              We've sent a confirmation link to {confirmationSentTo}. Open it, then come back and log
              in — your rehearsals will be saved from then on.
            </p>
            <Button type="button" onClick={onClose} className={styles.submit}>
              Back to Rehearsal
            </Button>
          </>
        ) : (
          <>
            <h2 id="auth-modal-title" className="bh-h2">
              {copy.title}
            </h2>
            <p className={styles.subhead}>{copy.subhead}</p>

            <form onSubmit={handleSubmit} className={styles.form}>
              <label className={styles.field}>
                <span className={styles.label}>Email</span>
                <input
                  ref={firstFieldRef}
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                />
              </label>

              <PasswordInput
                label="Password"
                value={password}
                onChange={setPassword}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              />

              {mode === 'register' && (
                <>
                  <PasswordInput
                    label="Confirm password"
                    value={confirmPassword}
                    onChange={setConfirmPassword}
                    autoComplete="new-password"
                  />
                  {passwordsMismatched && <p className={styles.hint}>Passwords don't match yet.</p>}
                </>
              )}

              {error && <p className={styles.error}>{error}</p>}

              <Button type="submit" disabled={submitting || passwordsMismatched} className={styles.submit}>
                {submitting ? 'One moment…' : copy.submitLabel}
              </Button>
            </form>

            <button type="button" className={styles.toggle} onClick={toggleMode}>
              {copy.toggleLabel}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
