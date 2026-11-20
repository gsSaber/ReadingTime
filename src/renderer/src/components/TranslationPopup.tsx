import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LookupEntry, SelectionContext, TranslationFont, TranslationMode } from '@shared/types'
import { TARGET_LANGUAGES } from '../lib/constants'
import { clamp, cn } from '../lib/format'
import { Icon } from './Icon'
import { ResultFeedback } from './ResultFeedback'

export interface TranslationAnchor {
  left: number
  top: number
  right: number
  bottom: number
}

export interface TranslationViewState {
  feedbackId?: string
  requestId: string
  sourceText: string
  targetLanguage: string
  status: 'loading' | 'streaming' | 'done' | 'error'
  text: string
  error?: string
  errorCode?: string
  truncated: boolean
  anchor: TranslationAnchor
  mode: TranslationMode
  context?: SelectionContext
  lookup?: LookupEntry
}

interface TranslationPopupProps {
  translation: TranslationViewState
  font: TranslationFont
  fontSize: number
  lineHeight: number
  onClose: () => void
  onRetry: () => void
  onOpenSettings: () => void
  onUpdateAppearance: (patch: {
    translationFont?: TranslationFont
    translationFontSize?: number
  }) => void
  onChangeTargetLanguage: (language: string) => void
}

type Placement = 'below' | 'above'

const FONT_CHOICES: Array<{ value: TranslationFont; label: string; glyph: string }> = [
  { value: 'serif', label: '宋体', glyph: '宋' },
  { value: 'sans', label: '黑体', glyph: '黑' },
  { value: 'kai', label: '楷体', glyph: '楷' }
]

export function TranslationPopup({
  translation,
  font,
  fontSize,
  lineHeight,
  onClose,
  onRetry,
  onOpenSettings,
  onUpdateAppearance,
  onChangeTargetLanguage
}: TranslationPopupProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: -2000, top: -2000, maxHeight: 560 })
  const [placement, setPlacement] = useState<Placement>('below')
  const [sourceExpanded, setSourceExpanded] = useState(false)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [dragging, setDragging] = useState(false)
  const manualPositionRef = useRef<{ left: number; top: number } | null>(null)
  const dragRef = useRef<{
    pointerId: number; x: number; y: number; left: number; top: number; height: number
  } | null>(null)

  const languageOptions = useMemo(() => {
    const values: string[] = [...TARGET_LANGUAGES]
    if (
      translation.targetLanguage &&
      !values.includes(translation.targetLanguage)
    ) {
      values.unshift(translation.targetLanguage)
    }
    return values
  }, [translation.targetLanguage])

  useEffect(() => {
    setSourceExpanded(false)
    setAppearanceOpen(false)
    setCopied(false)
  }, [translation.requestId])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card) return
    // A new selection anchors a new popup; retries keep the manually chosen position.
    manualPositionRef.current = null
    dragRef.current = null
    setDragging(false)

    const place = (): void => {
      const rect = translation.anchor
      const gap = 12
      const margin = 14
      const bounds = card.getBoundingClientRect()
      const cardWidth = Math.min(430, window.innerWidth - margin * 2)
      const measuredHeight = bounds.height || 260
      if (manualPositionRef.current) {
        const manual = manualPositionRef.current
        const left = clamp(manual.left, margin, window.innerWidth - cardWidth - margin)
        const top = clamp(manual.top, 44, Math.max(44, window.innerHeight - margin - 150))
        manualPositionRef.current = { left, top }
        setPosition({ left, top, maxHeight: window.innerHeight - top - margin })
        return
      }
      const roomBelow = window.innerHeight - rect.bottom - gap - margin
      const roomAbove = rect.top - gap - margin
      let nextPlacement: Placement
      if (roomBelow >= 300) nextPlacement = 'below'
      else if (roomAbove >= 300) nextPlacement = 'above'
      else nextPlacement = roomBelow >= roomAbove ? 'below' : 'above'

      const available =
        nextPlacement === 'below' ? roomBelow : roomAbove
      const roomyLookup = translation.mode === 'lookup' && available < 480
      const maxHeight = roomyLookup ? Math.min(560, window.innerHeight - 58) : Math.max(150, available)
      let top: number
      if (nextPlacement === 'below') {
        top = rect.bottom + gap
      } else {
        const renderedHeight = Math.min(measuredHeight, maxHeight)
        top = Math.max(margin, rect.top - gap - renderedHeight)
      }
      top = Math.max(margin, Math.min(top, window.innerHeight - margin - 120))
      if (roomyLookup) top = clamp(top, 44, Math.max(44, window.innerHeight - margin - Math.min(measuredHeight, maxHeight)))
      const left = Math.max(
        margin,
        Math.min(rect.left, window.innerWidth - cardWidth - margin)
      )
      setPlacement(nextPlacement)
      setPosition({ left, top, maxHeight })
    }

    place()
    const observer = new ResizeObserver(place)
    observer.observe(card)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [translation.anchor])

  const moveTo = (left: number, top: number, height: number): void => {
    const card = cardRef.current
    if (!card) return
    const next = {
      left: clamp(left, 14, Math.max(14, window.innerWidth - card.offsetWidth - 14)),
      top: clamp(top, 44, Math.max(44, window.innerHeight - Math.min(height, window.innerHeight - 58) - 14))
    }
    manualPositionRef.current = next
    setPosition({ ...next, maxHeight: window.innerHeight - next.top - 14 })
  }

  const endDrag = (): void => {
    dragRef.current = null
    setDragging(false)
  }

  const copyTranslation = async (): Promise<void> => {
    if (!translation.text) return
    await window.readingTime.app.copyText(translation.text)
    setCopied(true)
  }

  const isLoading = translation.status === 'loading'
  const isError = translation.status === 'error'
  const isStreaming = translation.status === 'streaming'
  const isDone = translation.status === 'done'
  const isLookup = translation.mode === 'lookup'

  return (
    <div
      ref={cardRef}
      className={cn('translation-popup', `is-${translation.status}`, `place-${placement}`, dragging && 'is-dragging')}
      style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }}
      data-selection-ignore="true"
      role="dialog"
      aria-label={isLookup ? '词语释义' : '划词翻译'}
    >
      <header
        className="translation-head"
        title="拖动标题栏移动翻译窗口"
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as Element).closest('button, select, input, label, a')) return
          const bounds = cardRef.current?.getBoundingClientRect()
          if (!bounds) return
          event.preventDefault()
          manualPositionRef.current = { left: bounds.left, top: bounds.top }
          dragRef.current = {
            pointerId: event.pointerId, x: event.clientX, y: event.clientY,
            left: bounds.left, top: bounds.top, height: bounds.height
          }
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragging(true)
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (!drag || drag.pointerId !== event.pointerId) return
          moveTo(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y, drag.height)
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <div
          className="translation-identity"
          role="button"
          tabIndex={0}
          aria-label="移动翻译窗口"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
            event.preventDefault()
            const bounds = cardRef.current?.getBoundingClientRect()
            if (!bounds) return
            const step = event.shiftKey ? 40 : 10
            moveTo(bounds.left + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
              bounds.top + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0), bounds.height)
          }}
        >
          <span className="translation-mark">译</span>
          <span>
            <strong>阅读时光 · {isLookup ? '词语释义' : '翻译'}</strong>
            <small>
              {isLoading
                ? isLookup ? '正在分析词义与语境…' : '正在理解这段话…'
                : isStreaming
                  ? '译文正在抵达'
                  : isError
                    ? isLookup ? '释义暂未完成' : '翻译没有完成'
                    : '来自你的模型服务'}
            </small>
          </span>
        </div>
        <div className="translation-head-actions">
          <label className="target-select" title="切换目标语言">
            <select
              value={translation.targetLanguage}
              onChange={(event) => onChangeTargetLanguage(event.target.value)}
              aria-label="目标语言"
            >
              {languageOptions.map((language) => (
                <option key={language} value={language}>
                  {language}
                </option>
              ))}
            </select>
            <Icon name="chevron-down" size={12} />
          </label>
          <button
            type="button"
            className="icon-button subtle"
            onClick={onClose}
            aria-label="关闭翻译"
            title="关闭翻译"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      </header>

      <div className={cn('translation-source', sourceExpanded && 'is-expanded', isLookup && 'is-vocabulary')}>
        <span className="source-rail" aria-hidden="true" />
        <p>{translation.sourceText}</p>
        {translation.sourceText.length > 90 ? (
          <button
            type="button"
            className="source-toggle"
            onClick={() => setSourceExpanded((value) => !value)}
          >
            {sourceExpanded ? '收起原文' : '展开原文'}
            <Icon name="chevron-down" size={12} />
          </button>
        ) : null}
      </div>

      <div
        className="translation-result"
        data-font={font}
        style={{ fontSize: `${fontSize}px`, lineHeight }}
      >
        {isLoading && !translation.text ? (
          <div className="translation-skeleton" aria-label={isLookup ? '正在查询释义' : '正在翻译'}>
            <span style={{ width: '92%' }} />
            <span style={{ width: '78%' }} />
            <span style={{ width: '54%' }} />
          </div>
        ) : null}

        {isLookup && translation.lookup ? (
          <VocabularyEntry entry={translation.lookup} selection={translation.sourceText} context={translation.context} />
        ) : null}

        {!isLookup && translation.text ? (
          <p className="translation-text">
            {translation.text}
            {isStreaming ? <span className="streaming-caret" aria-hidden="true" /> : null}
          </p>
        ) : null}

        {isError ? (
          <div className="translation-error">
            <Icon name="alert" size={16} />
            <div>
              <p>{translation.error || '翻译失败，请稍后重试。'}</p>
              {translation.errorCode === 'not_configured' ? (
                <button type="button" className="inline-link" onClick={onOpenSettings}>
                  打开模型设置
                  <Icon name="chevron-right" size={12} />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {translation.truncated ? (
          <p className="translation-truncated">选区较长，已截取前 8000 个字符翻译。</p>
        ) : null}
        {isDone && translation.feedbackId && (
          <ResultFeedback key={translation.feedbackId} id={translation.feedbackId} />
        )}
      </div>

      {appearanceOpen ? (
        <div className="translation-appearance" aria-label="译文外观">
          <span className="appearance-label">字体</span>
          <div className="appearance-fonts">
            {FONT_CHOICES.map((choice) => (
              <button
                key={choice.value}
                type="button"
                className={cn('mini-font-button', font === choice.value && 'is-active')}
                data-font={choice.value}
                onClick={() => onUpdateAppearance({ translationFont: choice.value })}
                title={`使用${choice.label}`}
              >
                {choice.glyph}
              </button>
            ))}
          </div>
          <span className="appearance-divider" />
          <span className="appearance-label">字号</span>
          <div className="appearance-size">
            <button
              type="button"
              onClick={() =>
                onUpdateAppearance({ translationFontSize: Math.max(6, fontSize - 1) })
              }
              aria-label="减小译文字号"
            >
              <Icon name="minus" size={13} />
            </button>
            <span>{fontSize}</span>
            <button
              type="button"
              onClick={() =>
                onUpdateAppearance({ translationFontSize: Math.min(30, fontSize + 1) })
              }
              aria-label="增大译文字号"
            >
              <Icon name="plus" size={13} />
            </button>
          </div>
        </div>
      ) : null}

      <footer className="translation-foot">
        <span className={cn('translation-status', isDone && 'is-done')}>
          {isStreaming || isLoading ? (
            <>
              <span className="translation-pulse" />
              实时生成中
            </>
          ) : isError ? (
            '可以重试或检查模型配置'
          ) : (
            <>
              <Icon name="check" size={12} />
              {isLookup ? '词语释义完成' : '自动翻译完成'}
            </>
          )}
        </span>
        <div className="translation-tools">
          <button
            type="button"
            className={cn('icon-button subtle', appearanceOpen && 'is-active')}
            onClick={() => setAppearanceOpen((value) => !value)}
            aria-label="调整译文外观"
            title="字体与字号"
          >
            <Icon name="type" size={16} />
          </button>
          <button
            type="button"
            className="icon-button subtle"
            onClick={() => void copyTranslation()}
            disabled={!translation.text}
            aria-label={isLookup ? '复制释义' : '复制译文'}
            title={copied ? '已复制' : isLookup ? '复制释义' : '复制译文'}
          >
            <Icon name={copied ? 'check' : 'copy'} size={15} />
          </button>
          <button
            type="button"
            className="icon-button subtle"
            onClick={onRetry}
            disabled={isLoading || isStreaming}
            aria-label={isLookup ? '重新查询释义' : '重新翻译'}
            title={isLookup ? '重新查询释义' : '重新翻译'}
          >
            <Icon name="refresh" size={15} />
          </button>
        </div>
      </footer>
    </div>
  )
}

function VocabularyEntry({ entry, selection, context }: {
  entry: LookupEntry; selection: string; context?: SelectionContext
}): React.JSX.Element {
  const hasContext = Boolean(context?.before || context?.after)
  return (
    <div className="vocabulary-entry">
      {entry.lemma.toLocaleLowerCase() !== selection.toLocaleLowerCase() ? (
        <div className="vocabulary-lemma">原形 <strong>{entry.lemma}</strong></div>
      ) : null}
      <section className="vocabulary-contextual" aria-label="此处用法">
        <h3>此处用法 {entry.contextual ? <span className="vocabulary-pos">{entry.contextual.partOfSpeech}</span> : null}</h3>
        {entry.contextual ? (
          <>
            <p className="vocabulary-meaning">{entry.contextual.meaning}</p>
            {entry.contextual.explanation ? <p className="vocabulary-explanation">{entry.contextual.explanation}</p> : null}
          </>
        ) : (
          <p className="vocabulary-explanation">{hasContext ? '这段语境不足以确定此处的词性和含义。' : '未提取到可用语境，暂不判断此处的词性和含义。'}</p>
        )}
      </section>
      <section className="vocabulary-common" aria-label="常用释义">
        <h3>常用释义</h3>
        {entry.common.length ? (
          <dl>
            {entry.common.map((sense, index) => (
              <div className="vocabulary-sense" key={`${sense.partOfSpeech}-${index}`}>
                <dt>{sense.partOfSpeech}</dt>
                <dd>{sense.meanings.join('；')}</dd>
              </div>
            ))}
          </dl>
        ) : <p className="vocabulary-explanation">暂无可靠的常用释义。</p>}
      </section>
    </div>
  )
}
