export type IconName =
  | 'star'
  | 'lock'
  | 'check'
  | 'chevron-right'
  | 'chevron-left'
  | 'chevron-down'
  | 'chevron-up'
  | 'mic'
  | 'alert-triangle'
  | 'bookmark'
  | 'eye'
  | 'eye-off'
  | 'pause'
  | 'play'
  | 'scroll-down'
  | 'scroll-off'

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
    // Mirror of chevron-right rather than a CSS rotation, so it needs no wrapper
    // and lines up on the same optical centre.
    case 'chevron-left':
      return <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
    // Drawn out for the same reason as chevron-left: a rotated chevron-right
    // would need a wrapper to transform and would sit off the optical centre.
    case 'chevron-down':
      return <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    case 'chevron-up':
      return <path d="M6 15l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
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
    case 'pause':
      return (
        <>
          <rect x="6" y="4" width="4" height="16" rx="1" />
          <rect x="14" y="4" width="4" height="16" rx="1" />
        </>
      )
    case 'play':
      return <path d="M7 4l13 8-13 8z" strokeLinejoin="round" />
    case 'scroll-down':
      return (
        <>
          <path d="M12 4v14" strokeLinecap="round" />
          <path d="M6 13l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )
    case 'scroll-off':
      return (
        <>
          <path d="M12 4v6M12 14v4" strokeLinecap="round" />
          <path d="M6 13l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3 3l18 18" strokeLinecap="round" />
        </>
      )
    case 'eye':
      return (
        <>
          <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" strokeLinejoin="round" />
          <circle cx="12" cy="12" r="3" />
        </>
      )
    case 'eye-off':
      return (
        <>
          <path d="M9.5 9.8a3 3 0 0 0 4.2 4.2" />
          <path
            d="M6.3 6.3A15.6 15.6 0 0 0 2 12s4 7 10 7a9.5 9.5 0 0 0 4.2-.95M10.6 5.2A10 10 0 0 1 12 5c6 0 10 7 10 7a15.6 15.6 0 0 1-3.2 3.9"
            strokeLinecap="round"
          />
          <path d="M3 3l18 18" strokeLinecap="round" />
        </>
      )
  }
}
