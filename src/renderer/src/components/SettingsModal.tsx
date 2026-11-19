import { useEffect, useMemo, useState } from 'react'
import type {
  AppSettings,
  ConnectionTestResult,
  ReaderTone,
  SaveSettingsInput,
  SaveSettingsResult,
  TranslationFont
} from '@shared/types'
import { FONT_OPTIONS, MODEL_PRESETS, TARGET_LANGUAGES } from '../lib/constants'
import { cn } from '../lib/format'
import { Icon } from './Icon'
import { Modal, ModalCloseButton, Toggle } from './Modal'
import { TranslationRuntimeSettings } from './TranslationRuntimeSettings'

type SettingsTab = 'model' | 'translation' | 'reading'

interface SettingsModalProps {
  open: boolean
  settings: AppSettings
  onClose: () => void
  onSave: (input: SaveSettingsInput) => Promise<SaveSettingsResult>
}

interface TestState {
  status: 'idle' | 'loading' | 'success' | 'error'
  message: string
}

const TABS: Array<{ id: SettingsTab; label: string; icon: 'key' | 'translate' | 'book' }> = [
  { id: 'model', label: '模型服务', icon: 'key' },
  { id: 'translation', label: '翻译偏好', icon: 'translate' },
  { id: 'reading', label: '阅读与隐私', icon: 'book' }
]

const TONES: Array<{
  id: ReaderTone
  label: string
  description: string
  icon: 'sun' | 'leaf' | 'moon'
}> = [
  { id: 'original', label: '原色', description: '保留 PDF 原本的纸面颜色', icon: 'sun' },
  { id: 'sepia', label: '护眼', description: '柔和暖色，减弱屏幕冷光', icon: 'leaf' },
  { id: 'night', label: '夜间', description: '反色显示，适合暗光环境', icon: 'moon' }
]

export function SettingsModal({
  open,
  settings,
  onClose,
  onSave
}: SettingsModalProps): React.JSX.Element {
  const [tab, setTab] = useState<SettingsTab>('model')
  const [baseUrl, setBaseUrl] = useState(settings.llm.baseUrl)
  const [modelId, setModelId] = useState(settings.llm.modelId)
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [clearApiKey, setClearApiKey] = useState(false)
  const [targetLanguage, setTargetLanguage] = useState(settings.llm.targetLanguage)
  const [preferences, setPreferences] = useState(settings.preferences)
  const [test, setTest] = useState<TestState>({ status: 'idle', message: '' })
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setBaseUrl(settings.llm.baseUrl)
    setModelId(settings.llm.modelId)
    setTargetLanguage(settings.llm.targetLanguage)
    setPreferences(settings.preferences)
    setApiKey('')
    setShowApiKey(false)
    setClearApiKey(false)
    setTest({ status: 'idle', message: '' })
    setSaveError('')
    setSaving(false)
    setTab(settings.llm.modelId ? 'translation' : 'model')
  }, [open, settings])

  const activePreset = useMemo(
    () =>
      MODEL_PRESETS.find(
        (preset) => preset.baseUrl === baseUrl.trim() && preset.modelId === modelId.trim()
      )?.id ?? null,
    [baseUrl, modelId]
  )

  const endpointPreview = useMemo(() => {
    const value = baseUrl.trim().replace(/\/+$/, '')
    if (!value) return '等待填写 Base URL'
    return /\/chat\/completions$/i.test(value) ? value : `${value}/chat/completions`
  }, [baseUrl])

  const languageOptions = useMemo(() => {
    const values: string[] = [...TARGET_LANGUAGES]
    if (targetLanguage && !values.includes(targetLanguage as (typeof TARGET_LANGUAGES)[number])) {
      values.unshift(targetLanguage)
    }
    return values
  }, [targetLanguage])

  const patchPreferences = (patch: Partial<AppSettings['preferences']>): void => {
    setPreferences((current) => ({ ...current, ...patch }))
  }

  const handleTest = async (): Promise<void> => {
    setTest({ status: 'loading', message: '正在连接模型服务…' })
    try {
      const result: ConnectionTestResult = await window.readingTime.settings.testConnection({
        baseUrl,
        modelId,
        ...(clearApiKey ? {} : apiKey.trim() ? { apiKey: apiKey.trim() } : {})
      })
      setTest({
        status: result.ok ? 'success' : 'error',
        message: result.message
      })
    } catch (error) {
      setTest({
        status: 'error',
        message: error instanceof Error ? error.message : '连接测试失败。'
      })
    }
  }

  const handleSubmit = async (): Promise<void> => {
    if (baseUrl.trim()) {
      try {
        const parsed = new URL(baseUrl.trim())
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          setSaveError('Base URL 必须使用 http:// 或 https://。')
          setTab('model')
          return
        }
      } catch {
        setSaveError('Base URL 格式不正确，请填入完整地址。')
        setTab('model')
        return
      }
    }
    setSaving(true)
    setSaveError('')
    try {
      const result = await onSave({
        baseUrl: baseUrl.trim(),
        modelId: modelId.trim(),
        targetLanguage: targetLanguage.trim(),
        preferences,
        ...(clearApiKey ? { clearApiKey: true } : {}),
        ...(!clearApiKey && apiKey.trim() ? { apiKey: apiKey.trim() } : {})
      })
      if (!result.ok) {
        setSaveError(result.error || '保存失败，请稍后重试。')
        return
      }
      onClose()
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '保存失败，请稍后重试。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!saving) onClose()
      }}
      className="settings-modal"
      ariaLabel="设置"
    >
      <div className="settings-layout">
        <aside className="settings-nav">
          <div className="settings-nav-heading">
            <span className="eyebrow">READING TIME</span>
            <strong>偏好设置</strong>
          </div>
          <nav aria-label="设置分类">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cn('settings-nav-item', tab === item.id && 'is-active')}
                onClick={() => setTab(item.id)}
              >
                <Icon name={item.icon} size={17} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="settings-nav-foot">
            <span className={cn('status-dot', modelId ? 'is-ready' : 'is-warning')} />
            <span>{modelId ? '模型已配置' : '等待配置模型'}</span>
          </div>
        </aside>

        <form
          className="settings-main"
          onSubmit={(event) => {
            event.preventDefault()
            void handleSubmit()
          }}
        >
          <header className="settings-header">
            <div>
              <h2>
                {tab === 'model'
                  ? '模型服务'
                  : tab === 'translation'
                    ? '翻译偏好'
                    : '阅读与隐私'}
              </h2>
              <p>
                {tab === 'model'
                  ? '连接任意兼容 OpenAI Chat Completions 的服务。'
                  : tab === 'translation'
                    ? '让每一次划词翻译都按你的阅读习惯呈现。'
                    : '选择纸面观感，并了解数据去了哪里。'}
              </p>
            </div>
            <ModalCloseButton onClick={onClose} />
          </header>

          <div className="settings-scroll">
            {tab === 'model' ? (
              <div className="settings-section-stack">
                <section className="form-section">
                  <div className="section-heading">
                    <h3>快速选择</h3>
                    <span>预置常用服务，填入你的密钥即可使用。</span>
                  </div>
                  <div className="preset-grid">
                    {MODEL_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        className={cn('preset-card', activePreset === preset.id && 'is-active')}
                        onClick={() => {
                          setBaseUrl(preset.baseUrl)
                          setModelId(preset.modelId)
                          setTest({ status: 'idle', message: '' })
                        }}
                      >
                        <span className="preset-mark">{preset.name.slice(0, 1)}</span>
                        <span>
                          <strong>{preset.name}</strong>
                          <small>{preset.modelId}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                </section>

                <section className="form-section">
                  <div className="section-heading">
                    <h3>连接参数</h3>
                    <span>请求由独立翻译进程发出，API Key 不会暴露给阅读页面。</span>
                  </div>
                  <div className="form-grid">
                    <label className="field field-wide">
                      <span>Base URL</span>
                      <input
                        type="url"
                        value={baseUrl}
                        onChange={(event) => {
                          setBaseUrl(event.target.value)
                          setTest({ status: 'idle', message: '' })
                        }}
                        placeholder="https://api.openai.com/v1"
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <small>通常是服务地址的 /v1 路径；也支持完整的 /chat/completions 地址。</small>
                    </label>
                    <label className="field">
                      <span>模型 ID</span>
                      <input
                        type="text"
                        value={modelId}
                        onChange={(event) => {
                          setModelId(event.target.value)
                          setTest({ status: 'idle', message: '' })
                        }}
                        placeholder="例如 gpt-4o-mini"
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </label>
                    <label className="field">
                      <span>
                        API Key
                        {settings.llm.apiKeyConfigured ? (
                          <em className="field-badge">已保存</em>
                        ) : null}
                      </span>
                      <div className="secret-input">
                        <input
                          type={showApiKey ? 'text' : 'password'}
                          value={apiKey}
                          onChange={(event) => {
                            setApiKey(event.target.value)
                            setClearApiKey(false)
                            setTest({ status: 'idle', message: '' })
                          }}
                          placeholder={
                            clearApiKey
                              ? '保存后将清除已保存的密钥'
                              : settings.llm.apiKeyConfigured
                                ? '留空则保持现有密钥不变'
                                : '无需鉴权的本地模型可留空'
                          }
                          autoComplete="new-password"
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className="secret-toggle"
                          onClick={() => setShowApiKey((value) => !value)}
                          aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                        >
                          <Icon name={showApiKey ? 'eye-off' : 'eye'} size={16} />
                        </button>
                      </div>
                      <small>
                        {clearApiKey
                          ? '关闭设置前保存才会生效。'
                          : settings.llm.keyStorage === 'encrypted'
                            ? '密钥由 macOS 钥匙串加密保存在本机。'
                            : settings.llm.keyStorage === 'plaintext'
                              ? '系统钥匙串不可用，当前密钥以本地可读形式保存。'
                              : '密钥加密保存在本机，仅用于向你配置的模型服务鉴权。'}
                      </small>
                    </label>
                  </div>
                  <div className="key-row">
                    {settings.llm.apiKeyConfigured && !clearApiKey ? (
                      <button
                        type="button"
                        className="text-button danger-text"
                        onClick={() => {
                          setClearApiKey(true)
                          setApiKey('')
                        }}
                      >
                        移除已保存的 API Key
                      </button>
                    ) : null}
                    {clearApiKey ? (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setClearApiKey(false)}
                      >
                        撤销移除
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="secondary-button test-button"
                      onClick={() => void handleTest()}
                      disabled={test.status === 'loading' || !baseUrl.trim() || !modelId.trim()}
                    >
                      {test.status === 'loading' ? <span className="small-spinner" /> : <span className="test-ping" />}
                      测试连接
                    </button>
                  </div>
                  {test.status !== 'idle' ? (
                    <div className={cn('test-result', `is-${test.status}`)} role="status">
                      <Icon
                        name={test.status === 'success' ? 'check' : test.status === 'error' ? 'alert' : 'sparkles'}
                        size={15}
                      />
                      <span>{test.message}</span>
                    </div>
                  ) : null}
                </section>

                <section className="form-section endpoint-section">
                  <div className="section-heading">
                    <h3>调用方式</h3>
                    <span>模型请求由独立翻译进程发出，渲染页面接触不到密钥。</span>
                  </div>
                  <div className="endpoint-preview">
                    <span className="http-method">POST</span>
                    <code>{endpointPreview}</code>
                  </div>
                  <div className="endpoint-facts">
                    <span>
                      <Icon name="check" size={13} />
                      OpenAI Chat Completions 协议
                    </span>
                    <span>
                      <Icon name="check" size={13} />
                      流式返回，译文逐字浮现
                    </span>
                    <span>
                      <Icon name="check" size={13} />
                      发送选中文字；查词时附带附近语境
                    </span>
                  </div>
                </section>
              </div>
            ) : null}

            {tab === 'translation' ? (
              <div className="settings-section-stack">
                <TranslationRuntimeSettings />
                <section className="form-section">
                  <div className="section-heading">
                    <h3>翻译行为</h3>
                    <span>选中文字并松开鼠标后，会在选区旁显示译文。</span>
                  </div>
                  <Toggle
                    checked={preferences.autoTranslate}
                    onChange={(value) => patchPreferences({ autoTranslate: value })}
                    label="选中即翻译"
                    description="松开鼠标时自动发送当前选区；关闭后仍可在工具栏重新开启。"
                  />
                  <label className="field field-inline">
                    <span>目标语言</span>
                    <input
                      className="target-language-input"
                      type="text"
                      list="target-language-options"
                      value={targetLanguage}
                      onChange={(event) => setTargetLanguage(event.target.value)}
                      placeholder="例如 简体中文 / English"
                      maxLength={50}
                    />
                    <datalist id="target-language-options">
                      {languageOptions.map((language) => (
                        <option key={language} value={language} />
                      ))}
                    </datalist>
                  </label>
                </section>

                <section className="form-section">
                  <div className="section-heading">
                    <h3>译文外观</h3>
                    <span>保存后会立即用于翻译浮层，并记录在本机。</span>
                  </div>
                  <div className="font-choice-grid">
                    {FONT_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={cn(
                          'font-choice',
                          preferences.translationFont === option.value && 'is-active'
                        )}
                        data-font={option.value}
                        onClick={() =>
                          patchPreferences({ translationFont: option.value as TranslationFont })
                        }
                      >
                        <span className="font-choice-sample">{option.sample}</span>
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </button>
                    ))}
                  </div>

                  <div className="range-grid">
                    <label className="field">
                      <span>
                        字号 <em>{preferences.translationFontSize}px</em>
                      </span>
                      <input
                        type="range"
                        min="6"
                        max="30"
                        step="1"
                        value={preferences.translationFontSize}
                        onChange={(event) =>
                          patchPreferences({ translationFontSize: Number(event.target.value) })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>
                        行距 <em>{preferences.translationLineHeight.toFixed(1)}</em>
                      </span>
                      <input
                        type="range"
                        min="0"
                        max="2.4"
                        step="0.1"
                        value={preferences.translationLineHeight}
                        onChange={(event) =>
                          patchPreferences({ translationLineHeight: Number(event.target.value) })
                        }
                      />
                    </label>
                  </div>

                  <div
                    className="translation-preview"
                    data-font={preferences.translationFont}
                    style={{
                      fontSize: `${preferences.translationFontSize}px`,
                      lineHeight: preferences.translationLineHeight
                    }}
                  >
                    <span className="preview-label">译文预览</span>
                    <p>
                      阅读不是逃离生活，而是在别人的句子里，重新辨认自己的生活。
                    </p>
                  </div>
                </section>
              </div>
            ) : null}

            {tab === 'reading' ? (
              <div className="settings-section-stack">
                <section className="form-section">
                  <div className="section-heading">
                    <h3>阅读主题</h3>
                    <span>保存后同步切换界面与 PDF 纸面外观，不修改原始文件。</span>
                  </div>
                  <div className="tone-grid">
                    {TONES.map((tone) => (
                      <button
                        key={tone.id}
                        type="button"
                        className={cn(
                          'tone-card',
                          `tone-${tone.id}`,
                          preferences.readerTone === tone.id && 'is-active'
                        )}
                        onClick={() => patchPreferences({ readerTone: tone.id })}
                        aria-pressed={preferences.readerTone === tone.id}
                      >
                        <span className="tone-swatch">
                          <Icon name={tone.icon} size={20} />
                        </span>
                        <strong>{tone.label}</strong>
                        <small>{tone.description}</small>
                      </button>
                    ))}
                  </div>
                </section>

                <section className="form-section privacy-section">
                  <div className="section-heading">
                    <h3>你的数据在哪里</h3>
                    <span>阅读时光把桌面软件应有的隐私默认还给你。</span>
                  </div>
                  <ul className="privacy-list">
                    <li>
                      <Icon name="check" size={15} />
                      PDF 文件会复制到应用专属资料库，不依赖原文件路径。
                    </li>
                    <li>
                      <Icon name="check" size={15} />
                      阅读进度、书架目录和偏好全部保存在本机。
                    </li>
                    <li>
                      <Icon name="check" size={15} />
                      翻译时发送选中文字；查词时额外发送附近最多 800 字符的原文语境，用于判断此处用法。
                    </li>
                    <li>
                      <Icon name="check" size={15} />
                      API Key 由系统钥匙串加密，不会返回给渲染页面。
                    </li>
                  </ul>
                </section>
              </div>
            ) : null}
          </div>

          <footer className="settings-footer">
            <div className="settings-footer-hint">
              {saveError ? (
                <span className="save-error">
                  <Icon name="alert" size={14} />
                  {saveError}
                </span>
              ) : (
                <span>设置仅保存在这台电脑上</span>
              )}
            </div>
            <div className="settings-footer-actions">
              <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>
                取消
              </button>
              <button type="submit" className="primary-button" disabled={saving}>
                {saving ? <span className="small-spinner" /> : null}
                {saving ? '保存中…' : '保存设置'}
              </button>
            </div>
          </footer>
        </form>
      </div>
    </Modal>
  )
}
