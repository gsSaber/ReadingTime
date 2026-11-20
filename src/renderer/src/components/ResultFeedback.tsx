import { useState } from 'react'
import type { TranslationVote } from '@shared/types'

export function ResultFeedback({ id }: { id: string }): React.JSX.Element {
  const [vote, setVote] = useState<TranslationVote | null>(null)
  const [reason, setReason] = useState('')
  const [savedReason, setSavedReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function save(next: TranslationVote | null, note = ''): Promise<void> {
    setBusy(true)
    try {
      const result = await window.readingTime.translate.feedback(id, next, note)
      if (!result.ok) {
        setMessage(result.error || '反馈未保存，请重试。')
        return
      }
      setVote(next)
      setReason(note)
      setSavedReason(note)
      setMessage(next ? '已保存到本机' : '已撤销评价')
    } catch {
      setMessage('反馈未保存，请重试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="result-feedback" role="group" aria-label="评价这次结果">
      <div className="result-feedback-actions">
        <button type="button" aria-pressed={vote === 'up'} disabled={busy}
          onClick={() => void save(vote === 'up' ? null : 'up')}>点赞</button>
        <button type="button" aria-pressed={vote === 'down'} disabled={busy}
          onClick={() => void save(vote === 'down' ? null : 'down')}>点踩</button>
        <span role="status">{message}</span>
      </div>
      {vote === 'down' && (
        <div className="feedback-note">
          <textarea aria-label="点踩理由" placeholder="哪里需要改进？（选填）" value={reason}
            disabled={busy} rows={2} maxLength={1000} onChange={event => { setReason(event.target.value); setMessage('') }} />
          <button type="button" disabled={busy || reason.trim() === savedReason}
            onClick={() => void save('down', reason.trim())}>保存理由</button>
        </div>
      )}
    </div>
  )
}
