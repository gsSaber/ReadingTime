import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'
import { PasswordResponses } from 'pdfjs-dist'
import type {
  AppSettings,
  LibraryEntry,
  ReaderTone,
  TranslateResult,
  TranslationFont
} from '@shared/types'
import type { SelectionContext } from '@shared/types'
import { detectTranslationMode } from '@shared/lookup'
import {
  collectOutline,
  collectPageSizes,
  getSelectedPdfText,
  loadPdfDocument,
  type OutlineItem,
  type PdfPageSize
} from '../lib/pdf'
import { clamp, cn, progressPercent } from '../lib/format'
import { Icon } from './Icon'
import { PdfPageView } from './PdfPageView'
import { PdfScrollbar } from './PdfScrollbar'
import { OutlineDrawer } from './OutlineDrawer'
import {
  TranslationPopup,
  type TranslationAnchor,
  type TranslationViewState
} from './TranslationPopup'
import { Modal } from './Modal'

interface PdfReaderProps {
  entry: LibraryEntry
  settings: AppSettings
  sidebarVisible: boolean
  onToggleSidebar: () => void
  onProgress: (id: string, page: number, pageCount: number) => void
  onOpenSettings: () => void
  onUpdatePreferences: (patch: Partial<AppSettings['preferences']>) => void
  onChangeTargetLanguage: (language: string) => void
}

interface PasswordRequest {
  submit: (password: string) => void
  incorrect: boolean
}

const MIN_ZOOM = 0.5
const MAX_ZOOM = 2.6
const ZOOM_STEP = 0.1
const TONE_ORDER: ReaderTone[] = ['original', 'sepia', 'night']
const TONE_LABEL: Record<ReaderTone, string> = {
  original: '原色',
  sepia: '护眼',
  night: '夜间'
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(
    target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')
  )
}

function formatLoadError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name: string }).name
    if (name === 'PasswordException') return '这份 PDF 受密码保护，需要输入正确密码。'
    if (name === 'InvalidPDFException') return '无法解析这份文件，它可能已经损坏或不是 PDF。'
    if (name === 'MissingPDFException') return '找不到 PDF 文件，请尝试重新导入。'
    if (name === 'UnexpectedResponseException') return '读取 PDF 时遇到问题，请重新导入。'
  }
  return error instanceof Error ? error.message : '打开 PDF 时发生未知错误。'
}

export function PdfReader({
  entry,
  settings,
  sidebarVisible,
  onToggleSidebar,
  onProgress,
  onOpenSettings,
  onUpdatePreferences,
  onChangeTargetLanguage
}: PdfReaderProps): React.JSX.Element {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [pageSizes, setPageSizes] = useState<PdfPageSize[]>([])
  const [loadStatus, setLoadStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadingLabel, setLoadingLabel] = useState('正在打开文档…')
  const [loadingPercent, setLoadingPercent] = useState(0)
  const [loadError, setLoadError] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [passwordRequest, setPasswordRequest] = useState<PasswordRequest | null>(null)
  const [passwordValue, setPasswordValue] = useState('')
  const [passwordChecking, setPasswordChecking] = useState(false)

  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [zoom, setZoom] = useState(1)
  const [zoomInput, setZoomInput] = useState('100%')
  const [availableWidth, setAvailableWidth] = useState(0)
  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([])
  const [outlineLoading, setOutlineLoading] = useState(true)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [translation, setTranslation] = useState<TranslationViewState | null>(null)
  const [showBackToTop, setShowBackToTop] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  const scrollRootRef = useRef<HTMLDivElement>(null)
  const pagesRef = useRef<Map<number, HTMLDivElement>>(new Map())
  const currentPageRef = useRef(1)
  const pageInputRef = useRef<HTMLInputElement>(null)
  const initialScrollDoneRef = useRef(false)
  const didRestoreRef = useRef(false)
  const zoomAnchorRef = useRef<{ page: number; ratio: number; offset?: number } | null>(null)
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const passwordCanceledRef = useRef(false)
  const translationRef = useRef<TranslationViewState | null>(null)
  const activeTranslationIdRef = useRef<string | null>(null)
  const milestoneRef = useRef(0)

  const preferences = settings.preferences
  const numPages = pdf?.numPages ?? 0
  const tone = preferences.readerTone

  const setTranslationState = useCallback(
    (
      value:
        | TranslationViewState
        | null
        | ((previous: TranslationViewState | null) => TranslationViewState | null)
    ) => {
      setTranslation((previous) => {
        const next = typeof value === 'function' ? value(previous) : value
        translationRef.current = next
        return next
      })
    },
    []
  )

  const closeTranslation = useCallback(() => {
    const activeId = activeTranslationIdRef.current
    activeTranslationIdRef.current = null
    if (activeId) void window.readingTime.translate.cancel(activeId)
    setTranslationState(null)
  }, [setTranslationState])

  const registerPage = useCallback((pageNumber: number, element: HTMLDivElement | null) => {
    if (element) pagesRef.current.set(pageNumber, element)
    else pagesRef.current.delete(pageNumber)
  }, [])

  useEffect(() => {
    translationRef.current = translation
  }, [translation])

  useEffect(() => {
    if (currentPageRef.current !== currentPage) currentPageRef.current = currentPage
  }, [currentPage])

  useEffect(() => {
    return window.readingTime.translate.onDelta(({ requestId, delta }) => {
      if (requestId !== activeTranslationIdRef.current) return
      setTranslationState((previous) => {
        if (!previous || previous.requestId !== requestId) return previous
        return {
          ...previous,
          status: 'streaming',
          text: previous.text + delta
        }
      })
    })
  }, [setTranslationState])

  useEffect(() => {
    return () => {
      const activeId = activeTranslationIdRef.current
      activeTranslationIdRef.current = null
      if (activeId) void window.readingTime.translate.cancel(activeId)
    }
  }, [])

  const requestTranslation = useCallback(
    (sourceText: string, targetLanguage: string, anchor: TranslationAnchor, truncated: boolean,
      context?: SelectionContext) => {
      const previousId = activeTranslationIdRef.current
      if (previousId) void window.readingTime.translate.cancel(previousId)

      const requestId = crypto.randomUUID()
      activeTranslationIdRef.current = requestId
      setTranslationState({
        requestId,
        sourceText,
        targetLanguage,
        status: 'loading',
        text: '',
        truncated,
        anchor,
        context,
        mode: detectTranslationMode(sourceText)
      })

      void window.readingTime.translate
        .start({ requestId, text: sourceText, targetLanguage, context })
        .then((result: TranslateResult) => {
          if (activeTranslationIdRef.current !== requestId) return
          if (result.cancelled) {
            setTranslationState((previous) =>
              previous && previous.requestId === requestId
                ? {
                    ...previous,
                    status: 'error',
                    error: result.error?.message || '翻译已取消。',
                    errorCode: 'cancelled'
                  }
                : previous
            )
            return
          }
          if (result.ok) {
            setTranslationState((previous) =>
              previous && previous.requestId === requestId
                ? {
                    ...previous,
                    status: 'done',
                    text: result.text || previous.text,
                    mode: result.mode ?? previous.mode,
                    lookup: result.lookup,
                    feedbackId: result.feedbackId,
                    error: undefined,
                    errorCode: undefined
                  }
                : previous
            )
            return
          }
          setTranslationState((previous) =>
            previous && previous.requestId === requestId
              ? {
                  ...previous,
                  status: 'error',
                  text: result.text || previous.text,
                  error: result.error?.message || '翻译失败，请稍后重试。',
                  errorCode: result.error?.code
                }
              : previous
          )
        })
        .catch((error: unknown) => {
          if (activeTranslationIdRef.current !== requestId) return
          setTranslationState((previous) =>
            previous && previous.requestId === requestId
              ? {
                  ...previous,
                  status: 'error',
                  error: error instanceof Error ? error.message : '翻译失败，请稍后重试。',
                  errorCode: 'unknown'
                }
              : previous
          )
        })
    },
    [setTranslationState]
  )

  const handleSelection = useCallback(
    (selected: ReturnType<typeof getSelectedPdfText>) => {
      if (!selected) return
      const root = scrollRootRef.current
      if (!root) return
      const targetLanguage = settings.llm.targetLanguage
      const previous = translationRef.current

      if (
        previous &&
        previous.sourceText === selected.text &&
        previous.context?.before === selected.context?.before &&
        previous.context?.after === selected.context?.after &&
        previous.targetLanguage === targetLanguage &&
        previous.status !== 'error'
      ) {
        setTranslationState({ ...previous, anchor: selected.rect })
        return
      }

      requestTranslation(
        selected.text,
        targetLanguage,
        selected.rect,
        selected.truncated,
        selected.context
      )
    },
    [requestTranslation, setTranslationState, settings.llm.targetLanguage]
  )

  useEffect(() => {
    const scrollRoot = scrollRootRef.current
    if (!scrollRoot) return
    const onMouseUp = (event: MouseEvent): void => {
      if (event.button !== 0) return
      if (!settings.preferences.autoTranslate) return
      const target = event.target
      if (!(target instanceof Node) || !scrollRoot.contains(target)) return
      if (
        target instanceof Element &&
        target.closest('[data-selection-ignore="true"]')
      ) {
        return
      }
      window.setTimeout(() => {
        const selected = getSelectedPdfText(scrollRoot)
        if (selected) handleSelection(selected)
      }, 8)
    }
    scrollRoot.addEventListener('mouseup', onMouseUp)
    return () => scrollRoot.removeEventListener('mouseup', onMouseUp)
  }, [handleSelection, settings.preferences.autoTranslate])

  // Load document and page geometry when the entry or retry changes.
  useEffect(() => {
    let cancelled = false
    let loadedDocument: PDFDocumentProxy | null = null
    let localTask: PDFDocumentLoadingTask | null = null
    didRestoreRef.current = false
    initialScrollDoneRef.current = false
    passwordCanceledRef.current = false
    setPdf(null)
    setPageSizes([])
    setLoadStatus('loading')
    setLoadError('')
    setLoadingLabel('正在读取 PDF…')
    setLoadingPercent(0)
    setPasswordRequest(null)
    setPasswordChecking(false)
    setOutlineItems([])
    setOutlineLoading(true)
    closeTranslation()

    const run = async (): Promise<void> => {
      try {
        const bytes = await window.readingTime.library.read(entry.id)
        if (cancelled) return
        setLoadingLabel('正在解析 PDF…')
        setLoadingPercent(8)

        const task = loadPdfDocument(new Uint8Array(bytes), {
          onProgress: (loaded, total) => {
            if (cancelled) return
            const percent = total > 0 ? Math.round((loaded / total) * 100) : 0
            setLoadingPercent(Math.min(72, 8 + Math.round(percent * 0.64)))
            setLoadingLabel('正在解析 PDF…')
          }
        })
        localTask = task
        loadingTaskRef.current = task
        task.onPassword = (updatePassword: (password: string) => void, reason: number) => {
          if (cancelled) return
          setPasswordRequest({
            submit: updatePassword,
            incorrect: reason === PasswordResponses.INCORRECT_PASSWORD
          })
          setPasswordChecking(false)
          setPasswordValue('')
        }

        const document = await task.promise
        if (cancelled) {
          await document.destroy()
          return
        }
        loadedDocument = document
        setPasswordRequest(null)
        setPasswordChecking(false)
        setPdf(document)
        setCurrentPage((page) => clamp(page, 1, document.numPages))
        setLoadingLabel('正在准备页面…')

        const sizes = await collectPageSizes(document, (loaded, total) => {
          if (cancelled) return
          setLoadingPercent(76 + Math.round((loaded / total) * 24))
        })
        if (cancelled) return
        setPageSizes(sizes)
        setLoadStatus('ready')
        setLoadingPercent(100)

        setOutlineLoading(true)
        void collectOutline(document).then((items) => {
          if (cancelled) return
          setOutlineItems(items)
          setOutlineLoading(false)
        })
      } catch (error) {
        if (cancelled || passwordCanceledRef.current) return
        console.error('[pdf] Failed to open document.', error)
        setLoadError(formatLoadError(error))
        setLoadStatus('error')
        setPasswordRequest(null)
      }
    }

    void run()
    return () => {
      cancelled = true
      passwordCanceledRef.current = false
      setPasswordRequest(null)
      loadingTaskRef.current = null
      if (loadedDocument) void loadedDocument.destroy()
      else if (localTask) void localTask.destroy()
    }
  }, [closeTranslation, entry.id, loadAttempt])

  useEffect(() => {
    const root = scrollRootRef.current
    if (!root) return
    let previousWidth = root.clientWidth
    const updateWidth = (): void => {
      if (root.clientWidth !== previousWidth && initialScrollDoneRef.current) {
        const element = pagesRef.current.get(currentPageRef.current)
        if (element) {
          const bounds = element.getBoundingClientRect()
          const offset = root.getBoundingClientRect().top - bounds.top
          zoomAnchorRef.current = {
            page: currentPageRef.current,
            ratio: clamp(offset / Math.max(1, bounds.height), 0, 1),
            ...(offset < 0 ? { offset } : {})
          }
        }
      }
      previousWidth = root.clientWidth
      setAvailableWidth(root.clientWidth)
    }
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  const maxPageWidth = useMemo(
    () => pageSizes.reduce((max, size) => Math.max(max, size.width), 0) || 600,
    [pageSizes]
  )
  const fitScale = availableWidth > 0 ? (availableWidth - 76) / maxPageWidth : 1
  const displayScale = Math.max(0.12, fitScale * zoom)

  const getPageElements = useCallback(
    (): Array<[number, HTMLDivElement]> =>
      Array.from(pagesRef.current.entries()).sort((a, b) => a[0] - b[0]),
    []
  )

  const scrollToPage = useCallback(
    (page: number, behavior: ScrollBehavior = 'smooth') => {
      const root = scrollRootRef.current
      if (!root) return
      const target = clamp(Math.round(page), 1, Math.max(1, numPages))
      const element = pagesRef.current.get(target)
      if (!element) return
      const rootRect = root.getBoundingClientRect()
      const targetRect = element.getBoundingClientRect()
      const top = root.scrollTop + targetRect.top - rootRect.top - 18
      root.scrollTo({ top: Math.max(0, top), behavior })
      currentPageRef.current = target
      setCurrentPage(target)
      setPageInput(String(target))
      onProgress(entry.id, target, numPages)
    },
    [entry.id, numPages, onProgress]
  )

  const syncCurrentPageFromScroll = useCallback(() => {
    if (!initialScrollDoneRef.current) return
    const root = scrollRootRef.current
    if (!root) return
    const rootTop = root.getBoundingClientRect().top
    let visiblePage = 1
    for (const [pageNumber, element] of getPageElements()) {
      const top = element.getBoundingClientRect().top - rootTop
      if (top <= 110) visiblePage = pageNumber
      else break
    }
    if (visiblePage !== currentPageRef.current) {
      currentPageRef.current = visiblePage
      setCurrentPage(visiblePage)
      if (!pageInputRef.current || document.activeElement !== pageInputRef.current) {
        setPageInput(String(visiblePage))
      }
      onProgress(entry.id, visiblePage, numPages || pageSizes.length)
    }
  }, [entry.id, getPageElements, numPages, onProgress, pageSizes.length])

  useEffect(() => {
    const root = scrollRootRef.current
    if (!root || loadStatus !== 'ready') return
    let frame = 0
    const onScroll = (): void => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        syncCurrentPageFromScroll()
        const scrolled = root.scrollTop
        setShowBackToTop(scrolled > root.clientHeight * 1.2)
      })
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      root.removeEventListener('scroll', onScroll)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [loadStatus, syncCurrentPageFromScroll])

  // Restore the stored reading position after the page dimensions are known.
  useEffect(() => {
    if (loadStatus !== 'ready' || !pageSizes.length || didRestoreRef.current) return
    didRestoreRef.current = true
    const target = clamp(entry.lastPage || 1, 1, pageSizes.length)
    currentPageRef.current = target
    setCurrentPage(target)
    setPageInput(String(target))

    const frame = window.requestAnimationFrame(() => {
      const root = scrollRootRef.current
      const element = pagesRef.current.get(target)
      if (!root || !element) {
        initialScrollDoneRef.current = true
        return
      }
      const rootRect = root.getBoundingClientRect()
      const targetRect = element.getBoundingClientRect()
      const top = root.scrollTop + targetRect.top - rootRect.top - 18
      root.scrollTop = Math.max(0, top)
      initialScrollDoneRef.current = true
      syncCurrentPageFromScroll()
      onProgress(entry.id, target, pageSizes.length)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [entry.id, entry.lastPage, loadStatus, onProgress, pageSizes.length, syncCurrentPageFromScroll])

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current
    if (!anchor || loadStatus !== 'ready') return
    zoomAnchorRef.current = null
    const root = scrollRootRef.current
    const element = pagesRef.current.get(anchor.page)
    if (!root || !element) return
    const rootRect = root.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()
    const desiredOffset = anchor.offset ?? anchor.ratio * elementRect.height
    root.scrollTop += elementRect.top - rootRect.top + desiredOffset
  }, [displayScale, loadStatus])

  const changeZoom = useCallback(
    (nextZoom: number) => {
      const clamped = clamp(Math.round(nextZoom * 1000) / 1000, MIN_ZOOM, MAX_ZOOM)
      if (clamped === zoom) return
      const root = scrollRootRef.current
      const element = pagesRef.current.get(currentPageRef.current)
      if (root && element) {
        const rootRect = root.getBoundingClientRect()
        const elementRect = element.getBoundingClientRect()
        zoomAnchorRef.current = {
          page: currentPageRef.current,
          ratio: clamp((rootRect.top - elementRect.top) / Math.max(1, elementRect.height), 0, 1)
        }
      }
      setZoom(clamped)
    },
    [zoom]
  )

  useEffect(() => {
    setZoomInput(`${Math.round(zoom * 1000) / 10}%`)
  }, [zoom])

  const submitZoomInput = (value: string): void => {
    const raw = value.trim().replace(/[%％]$/, '').trim()
    const percent = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN
    if (!Number.isFinite(percent)) {
      setZoomInput(`${Math.round(zoom * 1000) / 10}%`)
      return
    }
    const next = clamp(Math.round(percent * 10) / 1000, MIN_ZOOM, MAX_ZOOM)
    changeZoom(next)
    setZoomInput(`${Math.round(next * 1000) / 10}%`)
  }

  const submitPageInput = (): void => {
    const parsed = Number.parseInt(pageInput, 10)
    if (!Number.isFinite(parsed)) {
      setPageInput(String(currentPage))
      return
    }
    scrollToPage(parsed)
    pageInputRef.current?.blur()
  }

  const goRelative = useCallback(
    (delta: number) => {
      const next = clamp(currentPageRef.current + delta, 1, numPages || 1)
      if (next !== currentPageRef.current) scrollToPage(next, 'smooth')
    },
    [numPages, scrollToPage]
  )

  const toggleTone = (): void => {
    const index = TONE_ORDER.indexOf(tone)
    const next = TONE_ORDER[(index + 1) % TONE_ORDER.length]
    onUpdatePreferences({ readerTone: next })
  }

  const retryTranslation = (): void => {
    if (!translation) return
    requestTranslation(
      translation.sourceText,
      translation.targetLanguage,
      translation.anchor,
      translation.truncated,
      translation.context
    )
  }

  const changeTranslationTarget = (language: string): void => {
    if (!translation) return
    onChangeTargetLanguage(language)
    requestTranslation(
      translation.sourceText,
      language,
      translation.anchor,
      translation.truncated,
      translation.context
    )
  }

  const updateTranslationAppearance = (patch: {
    translationFont?: TranslationFont
    translationFontSize?: number
  }): void => {
    onUpdatePreferences(patch)
  }

  const cancelPassword = (): void => {
    passwordCanceledRef.current = true
    setPasswordRequest(null)
    setPasswordChecking(false)
    setLoadError('已取消打开这份受密码保护的 PDF。')
    setLoadStatus('error')
    if (loadingTaskRef.current) void loadingTaskRef.current.destroy()
  }

  const submitPassword = (password: string): void => {
    if (!passwordRequest || !password) return
    setPasswordChecking(true)
    passwordRequest.submit(password)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      if (document.querySelector('.modal-layer')) return
      if (isEditableTarget(event.target)) {
        if (event.key === 'Escape') {
          ;(event.target as HTMLElement).blur()
        }
        return
      }
      if (event.key === 'Escape') {
        if (shortcutsOpen) {
          setShortcutsOpen(false)
          return
        }
        if (translation) {
          closeTranslation()
          return
        }
        if (outlineOpen) {
          setOutlineOpen(false)
          return
        }
      }
      const withModifier = event.metaKey || event.ctrlKey
      if (withModifier) {
        if (event.key === '+' || event.key === '=') {
          event.preventDefault()
          changeZoom(zoom + ZOOM_STEP)
        } else if (event.key === '-') {
          event.preventDefault()
          changeZoom(zoom - ZOOM_STEP)
        } else if (event.key === '0') {
          event.preventDefault()
          changeZoom(1)
        } else if (event.key.toLowerCase() === 'b') {
          event.preventDefault()
          onToggleSidebar()
        }
        return
      }
      if (event.altKey) return
      if (event.key === '?' || (event.shiftKey && event.key === '/')) {
        event.preventDefault()
        setShortcutsOpen((open) => !open)
        return
      }
      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        const selection = window.getSelection()
        if (selection && !selection.isCollapsed) return
        event.preventDefault()
        goRelative(1)
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        const selection = window.getSelection()
        if (selection && !selection.isCollapsed) return
        event.preventDefault()
        goRelative(-1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [changeZoom, closeTranslation, goRelative, onToggleSidebar, outlineOpen, shortcutsOpen, translation, zoom])

  // Celebrate reading milestones once per quarter of the book.
  useEffect(() => {
    if (loadStatus !== 'ready' || !initialScrollDoneRef.current || numPages < 8) return
    const ratio = currentPage / numPages
    const milestone = ratio >= 1 ? 4 : ratio >= 0.75 ? 3 : ratio >= 0.5 ? 2 : ratio >= 0.25 ? 1 : 0
    if (milestone <= milestoneRef.current) return
    milestoneRef.current = milestone
    const root = scrollRootRef.current
    if (!root) return
    const note = document.createElement('div')
    note.className = 'reading-milestone'
    note.textContent = milestone === 4 ? '读完全书' : `已读 ${milestone * 25}%`
    root.appendChild(note)
    window.setTimeout(() => note.remove(), 2400)
  }, [currentPage, loadStatus, numPages])

  const readerProgress =
    numPages > 0 ? Math.round((currentPage / numPages) * 100) : progressPercent(entry)
  const toneIcon = tone === 'original' ? 'sun' : tone === 'sepia' ? 'leaf' : 'moon'

  return (
    <section className="reader-pane" data-tone={tone}>
      <header className="reader-toolbar" data-selection-ignore="true">
        <div className="toolbar-left">
          <button
            type="button"
            className="icon-button toolbar-icon"
            onClick={onToggleSidebar}
            title={sidebarVisible ? '收起书架 (⌘ B)' : '展开书架'}
            aria-label={sidebarVisible ? '收起书架' : '展开书架'}
          >
            <Icon name={sidebarVisible ? 'panel-left-close' : 'panel-left-open'} size={18} />
          </button>
          <div className="toolbar-doc">
            <div className="toolbar-title-row">
              <span className="format-badge">PDF</span>
              <h1 title={entry.title}>{entry.title}</h1>
            </div>
            <p>
              {loadStatus === 'ready'
                ? `${numPages} 页 · 读到第 ${currentPage} 页`
                : loadStatus === 'error'
                  ? '未能打开'
                  : loadingLabel}
            </p>
          </div>
        </div>

        <div className="toolbar-center">
          <div className="page-controls">
            <button
              type="button"
              className="icon-button"
              onClick={() => goRelative(-1)}
              disabled={loadStatus !== 'ready' || currentPage <= 1}
              title="上一页 (←)"
              aria-label="上一页"
            >
              <Icon name="chevron-left" size={17} />
            </button>
            <label className="page-number">
              <span className="visually-hidden">当前页码</span>
              <input
                ref={pageInputRef}
                value={pageInput}
                onChange={(event) => {
                  if (/^\d{0,6}$/.test(event.target.value)) setPageInput(event.target.value)
                }}
                onFocus={(event) => event.currentTarget.select()}
                onBlur={() => setPageInput(String(currentPage))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    submitPageInput()
                  } else if (event.key === 'Escape') {
                    setPageInput(String(currentPage))
                    event.currentTarget.blur()
                  }
                }}
                inputMode="numeric"
                disabled={loadStatus !== 'ready'}
                aria-label="跳转到页码"
              />
              <span className="page-total">/ {numPages || '—'}</span>
            </label>
            <button
              type="button"
              className="icon-button"
              onClick={() => goRelative(1)}
              disabled={loadStatus !== 'ready' || currentPage >= numPages}
              title="下一页 (→)"
              aria-label="下一页"
            >
              <Icon name="chevron-right" size={17} />
            </button>
          </div>

          <span className="toolbar-separator" />

          <div className="zoom-controls">
            <button
              type="button"
              className="icon-button"
              onClick={() => changeZoom(zoom - ZOOM_STEP)}
              disabled={loadStatus !== 'ready' || zoom <= MIN_ZOOM}
              title="缩小 (⌘ −)"
              aria-label="缩小"
            >
              <Icon name="minus" size={16} />
            </button>
            <input
              type="text"
              className="zoom-value"
              value={zoomInput}
              onChange={(event) => setZoomInput(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={(event) => submitZoomInput(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  event.currentTarget.value = `${Math.round(zoom * 1000) / 10}%`
                  setZoomInput(event.currentTarget.value)
                  event.currentTarget.blur()
                }
              }}
              inputMode="decimal"
              aria-label="缩放比例（%）"
              disabled={loadStatus !== 'ready'}
              title="输入缩放比例（50%–260%）；⌘0 恢复适宽"
            />
            <button
              type="button"
              className="icon-button"
              onClick={() => changeZoom(zoom + ZOOM_STEP)}
              disabled={loadStatus !== 'ready' || zoom >= MAX_ZOOM}
              title="放大 (⌘ +)"
              aria-label="放大"
            >
              <Icon name="plus" size={16} />
            </button>
            {zoom !== 1 ? (
              <button
                type="button"
                className="zoom-reset"
                onClick={() => changeZoom(1)}
                title="恢复适宽 (⌘ 0)"
                aria-label="恢复适宽"
              >
                适宽
              </button>
            ) : null}
          </div>
        </div>

        <div className="toolbar-actions">
          <button
            type="button"
            className={cn(
              'auto-translate-pill',
              preferences.autoTranslate && 'is-on'
            )}
            onClick={() =>
              onUpdatePreferences({ autoTranslate: !preferences.autoTranslate })
            }
            title={
              preferences.autoTranslate
                ? '已开启：选中文字后自动翻译'
                : '已关闭划词自动翻译，点击开启'
            }
            aria-pressed={preferences.autoTranslate}
            aria-label={
              preferences.autoTranslate
                ? '划词即翻译已开启，点击关闭'
                : '划词即翻译已关闭，点击开启'
            }
          >
            <Icon name="sparkles" size={15} />
            <span className="toolbar-label">
              {preferences.autoTranslate ? '划词即译' : '划词翻译已关'}
            </span>
            <span className="pill-indicator" />
          </button>
          <button
            type="button"
            className="icon-button toolbar-icon"
            onClick={toggleTone}
            title={`阅读主题：${TONE_LABEL[tone]}（点击切换）`}
            aria-label={`阅读主题：${TONE_LABEL[tone]}`}
          >
            <Icon name={toneIcon} size={17} />
            <span className="toolbar-mini-label">{TONE_LABEL[tone]}</span>
          </button>
          <button
            type="button"
            className={cn('icon-button toolbar-icon', outlineOpen && 'is-active')}
            onClick={() => setOutlineOpen((open) => !open)}
            title="PDF 目录"
            aria-label="PDF 目录"
            aria-expanded={outlineOpen}
          >
            <Icon name="list" size={18} />
          </button>
          <button
            type="button"
            className="icon-button toolbar-icon"
            onClick={onOpenSettings}
            title="模型与阅读设置 (⌘ ,)"
            aria-label="打开设置"
          >
            <Icon name="settings" size={18} />
          </button>
          <button
            type="button"
            className="icon-button toolbar-icon"
            onClick={() => setShortcutsOpen(true)}
            title="键盘快捷键 (?)"
            aria-label="查看键盘快捷键"
          >
            <Icon name="help" size={17} />
          </button>
        </div>
        <div className="reader-progress-bar" aria-hidden="true">
          <span style={{ width: `${readerProgress}%` }} />
        </div>
      </header>

      <div className="reader-body">
        <div
          id="pdf-document-scroll"
          className={cn('pdf-scroll', `tone-${tone}`, loadStatus === 'ready' && 'is-ready')}
          ref={scrollRootRef}
        >
          {loadStatus === 'ready' ? (
            <div className="pdf-pages">
              {pageSizes.map((size, index) => (
                <PdfPageView
                  key={index + 1}
                  pdf={pdf as PDFDocumentProxy}
                  pageNumber={index + 1}
                  width={size.width}
                  height={size.height}
                  scale={displayScale}
                  tone={tone}
                  scrollRootRef={scrollRootRef}
                  registerPage={registerPage}
                />
              ))}
              <div className="end-of-document" data-selection-ignore="true">
                <span className="end-mark">终</span>
                <p>你已读到最后一页</p>
                <span>PDF · {numPages} 页</span>
              </div>
            </div>
          ) : null}
        </div>

        {loadStatus === 'ready' ? <PdfScrollbar scrollRootRef={scrollRootRef} /> : null}

        {showBackToTop && loadStatus === 'ready' ? (
          <button
            type="button"
            className="back-to-top"
            onClick={() => scrollToPage(1)}
            title="回到第一页"
            aria-label="回到第一页"
            data-selection-ignore="true"
          >
            <Icon name="arrow-up" size={16} />
          </button>
        ) : null}

        {loadStatus === 'loading' ? (
          <div className="reader-loading" aria-live="polite">
            <div className="loading-paper" aria-hidden="true">
              <span className="loading-book-spine" />
              <span className="loading-page-line wide" />
              <span className="loading-page-line" />
              <span className="loading-page-line short" />
              <span className="loading-page-line wide" />
              <span className="loading-page-line" />
            </div>
            <div className="loading-copy">
              <span className="eyebrow">PREPARING YOUR PAGES</span>
              <h2>{loadingLabel}</h2>
              <p>{entry.title}</p>
              <div className="loading-progress">
                <span style={{ width: `${Math.max(6, loadingPercent)}%` }} />
              </div>
              <span className="loading-percent">{loadingPercent}%</span>
            </div>
          </div>
        ) : null}

        {loadStatus === 'error' ? (
          <div className="reader-error">
            <span className="reader-error-icon">
              <Icon name="alert" size={24} />
            </span>
            <span className="eyebrow">CAN'T OPEN THIS DOCUMENT</span>
            <h2>这一页暂时没有打开</h2>
            <p>{loadError}</p>
            <div className="reader-error-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              >
                <Icon name="refresh" size={16} />
                重新尝试
              </button>
            </div>
          </div>
        ) : null}

        <OutlineDrawer
          open={outlineOpen}
          loading={outlineLoading}
          items={outlineItems}
          currentPage={currentPage}
          onSelectPage={scrollToPage}
          onClose={() => setOutlineOpen(false)}
        />

        {translation ? (
          <TranslationPopup
            translation={translation}
            font={preferences.translationFont}
            fontSize={preferences.translationFontSize}
            lineHeight={preferences.translationLineHeight}
            onClose={closeTranslation}
            onRetry={retryTranslation}
            onOpenSettings={onOpenSettings}
            onUpdateAppearance={updateTranslationAppearance}
            onChangeTargetLanguage={changeTranslationTarget}
          />
        ) : null}
      </div>

      <Modal
        open={Boolean(passwordRequest)}
        onClose={cancelPassword}
        className="small-modal password-modal"
        ariaLabel="输入 PDF 密码"
        closeOnBackdrop={false}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submitPassword(passwordValue)
          }}
        >
          <header className="small-modal-header">
            <div>
              <span className="eyebrow">PROTECTED PDF</span>
              <h2>这份文档需要密码</h2>
            </div>
          </header>
          <p className="small-modal-description">
            “{entry.title}”受密码保护。密码只用于本机解开文档，不会被保存。
          </p>
          <label className="field">
            <span>PDF 密码</span>
            <input
              type="password"
              value={passwordValue}
              onChange={(event) => {
                setPasswordValue(event.target.value)
                if (passwordRequest?.incorrect) {
                  setPasswordRequest({ ...passwordRequest, incorrect: false })
                  setPasswordChecking(false)
                }
              }}
              placeholder="输入文档密码"
              autoComplete="off"
              data-autofocus
            />
          </label>
          {passwordRequest?.incorrect && !passwordChecking ? (
            <p className="inline-error">密码不正确，请再试一次。</p>
          ) : null}
          {passwordChecking ? (
            <p className="password-checking">
              <span className="small-spinner" />
              正在验证密码…
            </p>
          ) : null}
          <footer className="small-modal-footer">
            <button type="button" className="secondary-button" onClick={cancelPassword}>
              取消
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={!passwordValue || passwordChecking}
            >
              打开文档
            </button>
          </footer>
        </form>
      </Modal>

      <Modal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        className="small-modal shortcuts-modal"
        ariaLabel="键盘快捷键"
      >
        <header className="small-modal-header">
          <div>
            <span className="eyebrow">KEYBOARD</span>
            <h2>键盘快捷键</h2>
          </div>
        </header>
        <dl className="shortcut-list">
          {[
            ['← / →', '上一页 / 下一页'],
            ['PageUp / PageDown', '上一页 / 下一页'],
            ['⌘ + / ⌘ −', '放大 / 缩小'],
            ['⌘ 0', '恢复适宽'],
            ['⌘ B', '显示或收起书架'],
            ['⌘ F', '搜索书架'],
            ['⌘ O', '导入 PDF'],
            ['⌘ ,', '打开设置'],
            ['?', '打开或关闭本面板'],
            ['Esc', '关闭浮层、目录或面板']
          ].map(([keys, action]) => (
            <div key={keys} className="shortcut-row">
              <dt>
                <kbd>{keys}</kbd>
              </dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
        <footer className="small-modal-footer">
          <button type="button" className="primary-button" onClick={() => setShortcutsOpen(false)}>
            知道了
          </button>
        </footer>
      </Modal>
    </section>
  )
}
