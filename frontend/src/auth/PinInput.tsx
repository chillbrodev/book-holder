import { useState } from 'react'
import type { ChangeEvent } from 'react'
import { Icon } from '../components/core/Icon'
import styles from './AuthModal.module.css'

export interface PinInputProps {
  label: string
  value: string
  onChange: (value: string) => void
  autoComplete: string
  inputRef?: React.Ref<HTMLInputElement>
}

export function PinInput({ label, value, onChange, autoComplete, inputRef }: PinInputProps) {
  const [visible, setVisible] = useState(false)

  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      <div className={styles.pinWrapper}>
        <input
          ref={inputRef}
          type={visible ? 'text' : 'password'}
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={8}
          value={value}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value.replace(/\D/g, ''))}
          autoComplete={autoComplete}
          required
        />
        <button
          type="button"
          className={styles.pinToggle}
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? 'Hide PIN' : 'Show PIN'}
        >
          <Icon name={visible ? 'eye-off' : 'eye'} size={18} />
        </button>
      </div>
    </label>
  )
}
