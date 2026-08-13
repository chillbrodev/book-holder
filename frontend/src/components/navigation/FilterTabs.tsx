import { cx } from '../../utils/cx'
import styles from './FilterTabs.module.css'

export interface FilterTabsProps {
  options: string[]
  value: string
  onChange: (value: string) => void
}

/** Simple text tabs, active tab gets filled background + stronger border, not color alone. */
export function FilterTabs({ options, value, onChange }: FilterTabsProps) {
  return (
    <div className={styles.tabs}>
      {options.map((option) => (
        <button key={option} type="button" className={cx(styles.tab, option === value && styles.active)} onClick={() => onChange(option)}>
          {option}
        </button>
      ))}
    </div>
  )
}
