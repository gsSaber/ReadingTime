import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { cn } from '../lib/format'

interface ModalProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  className?: string
  ariaLabel: string
  closeOnBackdrop?: boolean
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

export function Modal({
  open,
  onClose,
  children,
  className,
  ariaLabel,
  closeOnBackdrop = true
}: ModalProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    const firstFocusable = panel?.querySelector<HTMLElement>('[data-autofocus]') ||
      panel?.querySelector<HTMLElement>(FOCUSABLE)
    window.setTimeout(() => firstFocusable?.focus(), 20)

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !panel) return
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null
      )
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus?.()
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <div
      className="modal-layer"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose()
      }}
      data-selection-ignore="true"
    >
      <div
        ref={panelRef}
        className={cn('modal-panel', className)}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        {children}
      </div>
    </div>,
    document.body
  )
}

export function ModalCloseButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" className="icon-button" onClick={onClick} aria-label="关闭">
      <Icon name="x" size={18} />
    </button>
  )
}

interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description?: string
  disabled?: boolean
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false
}: ToggleProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn('toggle-row', disabled && 'is-disabled')}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span className="toggle-copy">
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      <span className={cn('switch', checked && 'is-on')} aria-hidden="true">
        <span className="switch-thumb" />
      </span>
    </button>
  )
}
