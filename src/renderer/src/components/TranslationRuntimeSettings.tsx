import { useEffect, useState } from 'react'
import type { TranslationRuntimeStatus, TranslationUpdateResult } from '@shared/types'

export function TranslationRuntimeSettings(): React.JSX.Element {
  const [status, setStatus] = useState<TranslationRuntimeStatus>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  useEffect(() => {
    let mounted = true
    void window.readingTime.translationRuntime.status().then(value => { if (mounted) setStatus(value) })
      .catch(() => { if (mounted) { setError(true); setMessage('无法读取翻译版本，请稍后重试。') } })
    return () => { mounted = false }
  }, [])

  const update = async (action: () => Promise<TranslationUpdateResult>): Promise<void> => {
    setBusy(true)
    setMessage('正在检查翻译更新…')
    setError(false)
    try {
      const result = await action()
      setStatus(result.status)
      setError(!result.ok && !result.canceled)
      setMessage(result.canceled ? '' : result.ok ? '已切换翻译版本，新请求立即使用；当前翻译会继续完成。' : result.error || '更新失败，当前版本继续可用。')
    } catch { setError(true); setMessage('更新失败，请稍后重试。') }
    finally { setBusy(false) }
  }

  return (
    <section className="form-section" aria-label="翻译版本">
      <div className="section-heading">
        <h3>翻译版本</h3>
        <span>更新立即生效，无需保存设置或重启阅读器。仅导入你信任的本地策略和更新包。</span>
      </div>
      <p>当前版本：<strong>{status?.builtin ? '内置版本' : status?.version ?? '读取中…'}</strong> · 策略：{status?.strategyVersion ?? '—'}</p>
      <div className="translation-runtime-actions">
        <button type="button" className="secondary-button" disabled={busy || !status}
          onClick={() => void update(() => window.readingTime.translationRuntime.importUpdate())}>
          {busy ? '检查中…' : '导入翻译更新'}
        </button>
        <button type="button" className="secondary-button" disabled={busy || !status?.canRollback}
          onClick={() => void update(() => window.readingTime.translationRuntime.rollback())}>回滚上一版本</button>
        <button type="button" className="secondary-button" disabled={busy || !status || status.builtin}
          onClick={() => void update(() => window.readingTime.translationRuntime.restoreBuiltin())}>恢复内置版本</button>
      </div>
      <details className="translation-runtime-help">
        <summary>这些操作有什么作用？</summary>
        <p><strong>导入翻译更新：</strong>从电脑中选择策略 JSON 或更新包，更新翻译规则、术语表或翻译模块。</p>
        <p><strong>回滚上一版本：</strong>撤销最近一次版本切换，回到上一个使用的翻译版本。</p>
        <p><strong>恢复内置版本：</strong>切回应用自带的翻译引擎与默认策略，保留书架、模型配置和阅读偏好。</p>
      </details>
      {message || status?.lastError ? <p role="status" className={error ? 'save-error' : undefined}>{message || status?.lastError}</p> : null}
    </section>
  )
}
