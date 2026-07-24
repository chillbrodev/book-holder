import type { ButtonHTMLAttributes } from 'react'
import { cx } from '../../utils/cx'
import styles from './Button.module.css'

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
}

/** Gold-filled primary, hairline secondary, terracotta destructive, gold ghost for inline actions. */
export function Button({ variant = 'primary', className, children, ...rest }: ButtonProps) {
  return (
    <button className={cx(styles.button, styles[variant], className)} {...rest}>
      {children}
    </button>
  )
}
