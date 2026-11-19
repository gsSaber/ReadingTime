import type { SVGProps } from 'react'

const paths = {
  book: (
    <>
      <path d="M12 6.5C10.4 5.2 8.3 4.6 5.5 4.6c-.8 0-1.5.1-2.1.3v13.2c.6-.2 1.3-.3 2.1-.3 2.8 0 4.9.6 6.5 1.9 1.6-1.3 3.7-1.9 6.5-1.9.8 0 1.5.1 2.1.3V4.9c-.6-.2-1.3-.3-2.1-.3-2.8 0-4.9.6-6.5 1.9Z" />
      <path d="M12 6.5v13.2" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.2 4.2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.88 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.88.34H9.1a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.88v.03a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V4.8c0-.4.4-.8.8-.8h4.4c.4 0 .8.4.8.8V7" />
      <path d="m6.5 7 .8 12.2c0 .9.8 1.6 1.7 1.6h5.9c.9 0 1.7-.7 1.7-1.6L17.5 7" />
      <path d="M10 11v5.5M14 11v5.5" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4.2L19 9.2a2.1 2.1 0 0 0 0-3l-1.2-1.2a2.1 2.1 0 0 0-3 0L4 15.8V20Z" />
      <path d="m13.5 6.5 4 4" />
    </>
  ),
  x: (
    <>
      <path d="m6 6 12 12M18 6 6 18" />
    </>
  ),
  'chevron-left': <path d="m15 18-6-6 6-6" />,
  'chevron-right': <path d="m9 18 6-6-6-6" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  minus: <path d="M5 12h14" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20.2 15.2A8.5 8.5 0 0 1 8.8 3.8 8.5 8.5 0 1 0 20.2 15.2Z" />,
  leaf: (
    <>
      <path d="M20 4.5C12 4.5 5.5 8 5.5 14.2c0 2.4 1.4 4.3 3.8 4.3 6.3 0 10.7-6.2 10.7-14Z" />
      <path d="M4 21c1.8-5.3 5-8.6 9.5-10.5" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2.5" />
      <path d="M16 8V5.8c0-.9-.7-1.8-1.8-1.8H5.8C4.7 4 4 4.9 4 5.8v8.4C4 15.3 4.7 16 5.8 16H8" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 6v5h-5" />
      <path d="M18.2 15.5A7.5 7.5 0 1 1 19.7 9" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16" />
    </>
  ),
  check: <path d="m4.5 12 5 5L20 6.5" />,
  alert: (
    <>
      <path d="M10.3 4.3 2.7 17.5A1.8 1.8 0 0 0 4.3 20h15.4a1.8 1.8 0 0 0 1.6-2.5L13.7 4.3a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4.5M12 17h.01" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'eye-off': (
    <>
      <path d="m3 3 18 18" />
      <path d="M10.6 6.1A10.8 10.8 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-2.2 3M6.2 6.7C3.9 8.4 2.5 12 2.5 12S6 18 12 18c1.5 0 2.8-.4 4-1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15.5" r="3.5" />
      <path d="m10.5 13 8-8M15 8l2 2M17.5 5.5l2 2" />
    </>
  ),
  sparkles: (
    <>
      <path d="M12 3.5 13.4 8l4.6 1.4-4.6 1.4L12 15.3l-1.4-4.5L6 9.4 10.6 8 12 3.5Z" />
      <path d="M19 15.5 19.7 18l2.3.7-2.3.8L19 22l-.8-2.5-2.2-.8 2.2-.7.8-2.5Z" />
      <path d="M5 3v3.5M3.2 4.8h3.6" />
    </>
  ),
  'panel-left-open': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16M14 9l3 3-3 3" />
    </>
  ),
  'panel-left-close': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16M17 9l-3 3 3 3" />
    </>
  ),
  'external-link': (
    <>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </>
  ),
  type: (
    <>
      <path d="M4 6h10M9 6v13M5.5 19h7" />
      <path d="M15 11h5M17.5 11v8M15.5 19h4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.3l3.2 1.8" />
    </>
  ),
  translate: (
    <>
      <path d="M3 5.5h9M7.5 3v2.5M10 5.5c-.5 3.6-2.8 6.4-6 8" />
      <path d="M5 9.5c1.6 2.2 3.7 3.6 6 4.2" />
      <path d="M13.5 20.5 17 12l3.5 8.5M14.8 17.3h4.4" />
    </>
  ),
  arrowLeft: (
    <>
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </>
  ),
  library: (
    <>
      <path d="M4 5h4v15H4zM10 5h4v15h-4z" />
      <path d="m16.5 5.8 3.4 14.4-3.8.9-3.4-14.4z" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.4 9.2a2.6 2.6 0 1 1 3.5 2.5c-.8.4-1.4 1-1.4 1.9" />
      <path d="M12 17h.01" />
    </>
  ),
  'arrow-up': (
    <>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </>
  )
} as const

export type IconName = keyof typeof paths

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
}

export function Icon({ name, size = 18, strokeWidth = 1.8, ...props }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  )
}
