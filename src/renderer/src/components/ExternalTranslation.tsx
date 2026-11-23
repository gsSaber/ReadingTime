import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_SELECTION_LENGTH, type AppSettings, type ExternalSelection, type SaveSettingsInput } from '@shared/types'
import { detectTranslationMode } from '@shared/lookup'
import { TranslationPopup, type TranslationViewState } from './TranslationPopup'

const anchor = { left: 0, top: 0, right: 0, bottom: 0 }

export function ExternalTranslation(): React.JSX.Element | null {
  const [settings, setSettings] = useState<AppSettings>()
  const [selection, setSelection] = useState<ExternalSelection | null>(null)
  const [result, setResult] = useState<TranslationViewState | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const active = useRef('')

  const run = useCallback(async (source: ExternalSelection, targetLanguage: string) => {
    if (active.current) void window.readingTime.translate.cancel(active.current)
    const requestId = crypto.randomUUID()
    active.current = requestId
    const state: TranslationViewState = {
      requestId, sourceText: source.text, context: source.context, targetLanguage,
      anchor, status: 'loading', text: '', truncated: false, mode: detectTranslationMode(source.text)
    }
    setSelection(source)
    setResult(state)
    try {
      const response = await window.readingTime.translate.start({ requestId, ...source, targetLanguage })
      if (active.current !== requestId) return
      setResult({ ...state, status: response.ok ? 'done' : 'error', text: response.text ?? '',
        error: response.error?.message, errorCode: response.error?.code,
        mode: response.mode ?? state.mode, lookup: response.lookup, feedbackId: response.feedbackId })
    } catch {
      if (active.current === requestId) setResult({ ...state, status: 'error', error: '翻译失败，请重试。' })
    }
  }, [])

  useEffect(() => {
    let attached = true
    const unsubscribe = window.readingTime.translate.onDelta(({ requestId, delta }) => {
      if (active.current === requestId) setResult(old => old?.requestId === requestId
        ? { ...old, status: 'streaming', text: old.text + delta } : old)
    })
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') window.readingTime.external.close() }
    window.addEventListener('keydown', escape)
    void Promise.all([window.readingTime.settings.get(), window.readingTime.external.initial()]).then(([current, seed]) => {
      if (!attached) return
      setSettings(current)
      document.documentElement.dataset.readerTone = current.preferences.readerTone
      if (seed) void run(seed, current.llm.targetLanguage)
    }).catch(() => { if (attached) setError('无法加载翻译设置。') })
    return () => {
      attached = false
      unsubscribe()
      window.removeEventListener('keydown', escape)
      if (active.current) void window.readingTime.translate.cancel(active.current)
      active.current = ''
    }
  }, [run])

  async function save(patch: SaveSettingsInput): Promise<void> {
    try {
      const response = await window.readingTime.settings.save(patch)
      if (!response.ok || !response.settings) throw new Error()
      setSettings(response.settings)
    } catch { setError('偏好保存失败。') }
  }

  if (settings && selection && result) return (
    <main className="external-window">
      <TranslationPopup standalone translation={result} font={settings.preferences.translationFont}
        fontSize={settings.preferences.translationFontSize} lineHeight={settings.preferences.translationLineHeight}
        onClose={window.readingTime.external.close} onOpenSettings={window.readingTime.external.settings}
        onRetry={() => void run(selection, result.targetLanguage)}
        onChangeTargetLanguage={language => { void save({ targetLanguage: language }); void run(selection, language) }}
        onUpdateAppearance={preferences => void save({ preferences })} />
      {error && <span className="external-error" role="alert">{error}</span>}
    </main>
  )
  if (!settings && !error) return null
  return (
    <form className="external-paste" onSubmit={event => {
      event.preventDefault()
      if (settings && draft.trim() && draft.length <= MAX_SELECTION_LENGTH) void run({ text: draft.trim() }, settings.llm.targetLanguage)
    }}>
      <label htmlFor="external-input">粘贴要翻译的文字</label>
      <textarea id="external-input" autoFocus value={draft} placeholder="在原应用复制文字后，按 ⌘V 粘贴。"
        onChange={event => setDraft(event.target.value)} />
      {draft.length > MAX_SELECTION_LENGTH && <small>单次最多翻译 {MAX_SELECTION_LENGTH} 个字符。</small>}
      {error && <small role="alert">{error}</small>}
      <div><button type="button" className="secondary-button" onClick={window.readingTime.external.close}>关闭</button>
        <button type="submit" className="primary-button" disabled={!settings || !draft.trim() || draft.length > MAX_SELECTION_LENGTH}>翻译</button></div>
    </form>
  )
}
