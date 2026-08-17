import { useState } from 'react'
import type { ChangeEvent } from 'react'
import { Icon } from '../components/core/Icon'
import styles from './AuthModal.module.css'

export interface PasswordInputProps {
  label: string
  value: string
  onChange: (value: string) => void
  autoComplete: string
  inputRef?: React.Ref<HTMLInputElement>
}

/** What `PinInput` was, without the digits-only constraints. No `minLength`
 * here on purpose: the length and complexity rules are the Supabase project's
 * (`minimum_password_length`, `password_requirements`), and a second copy of
 * them in this file would go stale the moment either is changed in the
 * dashboard — silently rejecting a password the server would have accepted, or
 * accepting one it won't. Supabase's own message is what the modal shows. */
export function PasswordInput({ label, value, onChange, autoComplete, inputRef }: PasswordInputProps) {
  const [visible, setVisible] = useState(false)

  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      <div className={styles.passwordWrapper}>
        <input
          ref={inputRef}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
          autoComplete={autoComplete}
          required
        />
        <button
          type="button"
          className={styles.passwordToggle}
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? 'Hide password' : 'Show password'}
        >
          <Icon name={visible ? 'eye-off' : 'eye'} size={18} />
        </button>
      </div>
    </label>
  )
}
