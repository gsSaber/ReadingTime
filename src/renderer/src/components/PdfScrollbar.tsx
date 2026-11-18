import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { clamp, cn } from '../lib/format'

interface PdfScrollbarProps {
  scrollRootRef: RefObject<HTMLDivElement | null>
}

export function PdfScrollbar({ scrollRootRef }: PdfScrollbarProps): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; offset: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [metrics, setMetrics] = useState({ top: 0, height: 0, progress: 0, overflow: false })

  useLayoutEffect(() => {
    const root = scrollRootRef.current
    const track = trackRef.current
    if (!root || !track) return
    let frame = 0
    const measure = (): void => {
      frame = 0
      const maxScroll = Math.max(0, root.scrollHeight - root.clientHeight)
      const height = Math.min(track.clientHeight, Math.max(36, track.clientHeight * root.clientHeight / Math.max(1, root.scrollHeight)))
      const progress = maxScroll > 0 ? clamp(root.scrollTop / maxScroll, 0, 1) : 0
      setMetrics({ top: progress * (track.clientHeight - height), height, progress, overflow: maxScroll > 1 })
    }
    const scheduleMeasure = (): void => {
      if (!frame) frame = window.requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(scheduleMeasure)
    observer.observe(root)
    observer.observe(track)
    if (root.firstElementChild) observer.observe(root.firstElementChild)
    root.addEventListener('scroll', scheduleMeasure, { passive: true })
    measure()
    return () => {
      observer.disconnect()
      root.removeEventListener('scroll', scheduleMeasure)
      window.cancelAnimationFrame(frame)
    }
  }, [scrollRootRef])

  const scrollAt = (clientY: number, offset: number): void => {
    const root = scrollRootRef.current
    const track = trackRef.current
    if (!root || !track) return
    const height = Math.min(track.clientHeight, Math.max(36, track.clientHeight * root.clientHeight / Math.max(1, root.scrollHeight)))
    const ratio = clamp((clientY - track.getBoundingClientRect().top - offset) / Math.max(1, track.clientHeight - height), 0, 1)
    root.scrollTo({ top: ratio * (root.scrollHeight - root.clientHeight), behavior: 'instant' })
  }

  const endDrag = (): void => {
    dragRef.current = null
    setDragging(false)
  }

  return (
    <div
      ref={trackRef}
      className={cn('pdf-scrollbar', dragging && 'is-dragging', !metrics.overflow && 'is-disabled')}
      role="scrollbar"
      aria-label="PDF 阅读滚动条"
      aria-controls="pdf-document-scroll"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(metrics.progress * 100)}
      aria-disabled={!metrics.overflow}
      tabIndex={metrics.overflow ? 0 : -1}
      data-selection-ignore="true"
      onPointerDown={(event) => {
        if (event.button !== 0 || !metrics.overflow) return
        event.preventDefault()
        event.currentTarget.focus()
        const thumb = event.currentTarget.firstElementChild as HTMLElement
        const offset = thumb.contains(event.target as Node) ? event.clientY - thumb.getBoundingClientRect().top : metrics.height / 2
        dragRef.current = { pointerId: event.pointerId, offset }
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
        scrollAt(event.clientY, offset)
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (drag?.pointerId === event.pointerId) scrollAt(event.clientY, drag.offset)
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={(event) => {
        const root = scrollRootRef.current
        if (!root || !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const step = event.key.startsWith('Page') ? root.clientHeight * 0.9 : 60
        const top = event.key === 'Home' ? 0 : event.key === 'End' ? root.scrollHeight
          : root.scrollTop + (event.key.endsWith('Down') ? step : -step)
        root.scrollTo({ top, behavior: 'instant' })
      }}
    >
      <div className="pdf-scrollbar-thumb" style={{ height: metrics.height, transform: `translateY(${metrics.top}px)` }} />
    </div>
  )
}
