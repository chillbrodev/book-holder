export type IconName = 'star' | 'lock' | 'check' | 'chevron-right' | 'mic' | 'alert-triangle' | 'bookmark'

export interface IconProps {
  name: IconName
  size?: number
  color?: string
  strokeWidth?: number
}

/**
 * Placeholder outline icon set (no real icon library was specified in the design system) — a
 * small hand-built set in a 24x24, 2px-stroke style similar to Lucide. The `name` prop API is
 * kept stable so a real icon library can swap the internals later without touching call sites.
 */
export function Icon({ name, size = 18, color = 'currentColor', strokeWidth = 2 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} aria-hidden="true">
      {renderIconBody(name)}
    </svg>
  )
}

function renderIconBody(name: IconName) {
  switch (name) {
    case 'star':
      return <path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7-6.2-3.9-6.2 3.9 1.6-7L2 9.2l7.1-.6z" strokeLinejoin="round" />
    case 'lock':
      return (
        <>
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </>
      )
    case 'check':
      return <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
    case 'chevron-right':
      return <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    case 'mic':
      return (
        <>
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
        </>
      )
    case 'alert-triangle':
      return (
        <>
          <path d="M12 3l10 18H2z" strokeLinejoin="round" />
          <line x1="12" y1="10" x2="12" y2="14" />
          <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" />
        </>
      )
    case 'bookmark':
      return <path d="M6 3h12v18l-6-4.5L6 21z" strokeLinejoin="round" />
  }
}
