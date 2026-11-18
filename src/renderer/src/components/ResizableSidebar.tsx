import { useEffect, useRef, useState, type ReactNode } from 'react'
import { clamp, cn } from '../lib/format'

const WIDTH_KEY = 'reading-time:sidebar-width'
const DEFAULT_WIDTH = 278
const MIN_WIDTH = 220

export function ResizableSidebar({ children }: { children: ReactNode }): React.JSX.Element {
  const [preferredWidth, setPreferredWidth] = useState(() => {
    const stored = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(stored) && stored >= MIN_WIDTH ? clamp(stored, MIN_WIDTH, 480) : DEFAULT_WIDTH
  })
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth)
  const [resizing, setResizing] = useState(false)
  const dragRef = useRef<{ pointerId: number; x: number; width: number } | null>(null)
  const maxWidth = Math.max(MIN_WIDTH, Math.min(480, viewportWidth - 640))
  const width = clamp(preferredWidth, MIN_WIDTH, maxWidth)

  useEffect(() => {
    const resize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(preferredWidth))
  }, [preferredWidth])

  const endDrag = (): void => {
    dragRef.current = null
    setResizing(false)
  }

  return (
    <div className={cn('library-panel', resizing && 'is-resizing')} style={{ width, flexBasis: width }}>
      {children}
      <div
        className="sidebar-resizer"
        role="separator"
        aria-label="调整书架宽度"
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maxWidth}
        aria-valuenow={Math.round(width)}
        aria-valuetext={`${Math.round(width)} 像素`}
        tabIndex={0}
        title="拖动调整宽度，双击恢复默认"
        data-selection-ignore="true"
        onDoubleClick={() => setPreferredWidth(DEFAULT_WIDTH)}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          dragRef.current = { pointerId: event.pointerId, x: event.clientX, width }
          event.currentTarget.setPointerCapture(event.pointerId)
          setResizing(true)
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (!drag || drag.pointerId !== event.pointerId) return
          setPreferredWidth(clamp(drag.width + event.clientX - drag.x, MIN_WIDTH, maxWidth))
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const step = event.shiftKey ? 40 : 10
          setPreferredWidth(event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? maxWidth
            : clamp(width + (event.key === 'ArrowRight' ? step : -step), MIN_WIDTH, maxWidth))
        }}
      />
    </div>
  )
}
