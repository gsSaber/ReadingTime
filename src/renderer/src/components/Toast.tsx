import { useEffect, useRef } from 'react'
import { Icon } from './Icon'
import { cn } from '../lib/format'

export interface ToastState {
  id: number
  type: 'success' | 'error' | 'info'
  message: string
}

interface ToastProps {
  toast: ToastState | null
  onDismiss: () => void
}

export function Toast({ toast, onDismiss }: ToastProps): React.JSX.Element | null {
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!toast) return
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(onDismiss, toast.type === 'error' ? 7000 : 4500)
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [onDismiss, toast])

  if (!toast) return null

  return (
    <div className={cn('toast', `toast-${toast.type}`)} role="status" data-selection-ignore="true">
      <span className="toast-icon">
        <Icon
          name={toast.type === 'success' ? 'check' : toast.type === 'error' ? 'alert' : 'sparkles'}
          size={16}
        />
      </span>
      <span>{toast.message}</span>
      <button type="button" className="toast-close" onClick={onDismiss} aria-label="关闭提示">
        <Icon name="x" size={13} />
      </button>
    </div>
  )
}
