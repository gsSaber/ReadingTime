import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  AppCommand,
  AppSettings,
  ImportResult,
  LibraryEntry,
  SaveSettingsInput,
  SaveSettingsResult
} from '@shared/types'
import { EmptyState } from './components/EmptyState'
import { LibrarySidebar } from './components/LibrarySidebar'
import { ResizableSidebar } from './components/ResizableSidebar'
import { PdfReader } from './components/PdfReader'
import { SettingsModal } from './components/SettingsModal'
import { DocumentDialogs, type DocumentDialogState } from './components/DocumentDialogs'
import { Toast, type ToastState } from './components/Toast'
import { Icon } from './components/Icon'
import { cn } from './lib/format'

const LAST_DOC_KEY = 'reading-time:last-document'

export default function App(): React.JSX.Element {
  const [bootStatus, setBootStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [bootError, setBootError] = useState('')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sidebarVisible, setSidebarVisible] = useState(
    () => localStorage.getItem('reading-time:sidebar') !== 'closed'
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [dialog, setDialog] = useState<DocumentDialogState>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [version, setVersion] = useState('')

  const settingsRef = useRef<AppSettings | null>(null)
  const entriesRef = useRef<LibraryEntry[]>([])
  const selectedIdRef = useRef<string | null>(null)
  const importingRef = useRef(false)
  const dragDepthRef = useRef(0)
  const toastCounterRef = useRef(0)
  const commandHandlerRef = useRef<(command: AppCommand) => void>(() => {})

  settingsRef.current = settings
  entriesRef.current = entries
  selectedIdRef.current = selectedId

  const showToast = useCallback((message: string, type: ToastState['type'] = 'info') => {
    toastCounterRef.current += 1
    setToast({ id: toastCounterRef.current, message, type })
  }, [])

  const dismissToast = useCallback(() => setToast(null), [])

  const boot = useCallback(async () => {
    setBootStatus('loading')
    setBootError('')
    try {
      const [list, loadedSettings, appVersion] = await Promise.all([
        window.readingTime.library.list(),
        window.readingTime.settings.get(),
        window.readingTime.app.getVersion()
      ])
      const rememberedId = localStorage.getItem(LAST_DOC_KEY)
      const initialId =
        rememberedId && list.some((entry) => entry.id === rememberedId)
          ? rememberedId
          : (list[0]?.id ?? null)
      setEntries(list)
      setSettings(loadedSettings)
      setVersion(appVersion)
      setSelectedId(initialId)
      setBootStatus('ready')
    } catch (error) {
      console.error('[app] Failed to initialize.', error)
      setBootError(error instanceof Error ? error.message : '应用初始化失败，请重新打开。')
      setBootStatus('error')
    }
  }, [])

  useEffect(() => {
    void boot()
  }, [boot])

  useLayoutEffect(() => {
    if (!settings) return
    const tone = settings.preferences.readerTone
    document.documentElement.dataset.readerTone = tone
    localStorage.setItem('reading-time:tone', tone)
  }, [settings?.preferences.readerTone])

  useEffect(() => {
    if (bootStatus !== 'ready') return
    const selected = entries.find((entry) => entry.id === selectedId)
    document.title = selected ? `${selected.title} — 阅读时光` : '阅读时光'
    if (selected) {
      localStorage.setItem(LAST_DOC_KEY, selected.id)
    } else {
      localStorage.removeItem(LAST_DOC_KEY)
    }
  }, [bootStatus, entries, selectedId])

  useEffect(() => {
    localStorage.setItem('reading-time:sidebar', sidebarVisible ? 'open' : 'closed')
  }, [sidebarVisible])

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.id === selectedId) ?? null,
    [entries, selectedId]
  )

  const applySettings = useCallback((next: AppSettings) => {
    settingsRef.current = next
    setSettings(next)
  }, [])

  const updatePreferences = useCallback(
    (patch: Partial<AppSettings['preferences']>) => {
      const current = settingsRef.current
      if (!current) return
      const next: AppSettings = {
        ...current,
        preferences: { ...current.preferences, ...patch }
      }
      applySettings(next)
      void window.readingTime.settings
        .save({ preferences: next.preferences })
        .then((result) => {
          if (!result.ok) {
            showToast(result.error || '阅读偏好保存失败。', 'error')
          }
        })
        .catch((error: unknown) => {
          showToast(error instanceof Error ? error.message : '阅读偏好保存失败。', 'error')
        })
    },
    [applySettings, showToast]
  )

  const changeTargetLanguage = useCallback(
    (language: string) => {
      const current = settingsRef.current
      if (!current) return
      const next: AppSettings = {
        ...current,
        llm: { ...current.llm, targetLanguage: language }
      }
      applySettings(next)
      void window.readingTime.settings
        .save({ targetLanguage: language })
        .then((result) => {
          if (!result.ok) showToast(result.error || '目标语言保存失败。', 'error')
        })
        .catch((error: unknown) => {
          showToast(error instanceof Error ? error.message : '目标语言保存失败。', 'error')
        })
    },
    [applySettings, showToast]
  )

  const saveAllSettings = useCallback(
    async (input: SaveSettingsInput): Promise<SaveSettingsResult> => {
      try {
        const result = await window.readingTime.settings.save(input)
        if (result.ok && result.settings) {
          applySettings(result.settings)
          showToast('设置已保存。', 'success')
        }
        return result
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : '设置保存失败。'
        }
      }
    },
    [applySettings, showToast]
  )

  const refreshLibrary = useCallback(async (): Promise<LibraryEntry[]> => {
    const list = await window.readingTime.library.list()
    setEntries(list)
    return list
  }, [])

  const selectEntry = useCallback((entry: LibraryEntry) => {
    setSelectedId(entry.id)
    setEntries((current) =>
      current.map((candidate) =>
        candidate.id === entry.id ? { ...candidate, openedAt: Date.now() } : candidate
      )
    )
  }, [])

  const runImport = useCallback(
    async (loader: () => Promise<ImportResult>) => {
      if (importingRef.current) return
      importingRef.current = true
      setImporting(true)
      try {
        const result = await loader()
        if (result.canceled) return
        const refreshed = await refreshLibrary()
        const first = result.imported[0] || result.existing?.[0]
        if (first) {
          const exists = refreshed.find((entry) => entry.id === first.id)
          if (exists) selectEntry(exists)
        }
        const parts: string[] = []
        if (result.imported.length) parts.push(`已导入 ${result.imported.length} 本 PDF`)
        if (result.duplicates.length) {
          parts.push(`${result.duplicates.length} 本已在书架中`)
        }
        if (result.failed.length) {
          const first = result.failed[0]
          const detail = first.error.length > 100 ? `${first.error.slice(0, 100)}…` : first.error
          parts.push(`${first.name} 导入失败：${detail}`)
          if (result.failed.length > 1) parts.push(`另有 ${result.failed.length - 1} 个文件失败`)
        }
        if (parts.length) {
          showToast(
            parts.join('；'),
            result.imported.length
              ? result.failed.length
                ? 'info'
                : 'success'
              : result.failed.length ? 'error' : 'info'
          )
        }
      } catch (error) {
        showToast(error instanceof Error ? error.message : '导入失败，请重试。', 'error')
      } finally {
        importingRef.current = false
        setImporting(false)
      }
    },
    [refreshLibrary, selectEntry, showToast]
  )

  const openImportDialog = useCallback(() => {
    void runImport(() => window.readingTime.library.importDialog())
  }, [runImport])

  const importPaths = useCallback(
    (paths: string[]) => {
      if (!paths.length) {
        showToast('没有找到可导入的 PDF 文件。', 'error')
        return
      }
      void runImport(() => window.readingTime.library.importPaths(paths))
    },
    [runImport, showToast]
  )

  const handleProgress = useCallback((id: string, page: number, pageCount: number) => {
    setEntries((current) =>
      current.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              lastPage: page,
              pageCount: pageCount || entry.pageCount,
              openedAt: entry.openedAt || Date.now()
            }
          : entry
      )
    )
    void window.readingTime.library
      .update(id, {
        lastPage: page,
        ...(pageCount > 0 ? { pageCount } : {})
      })
      .catch((error: unknown) => {
        console.error('[library] Failed to save reading progress.', error)
      })
  }, [])

  const renameEntry = useCallback(
    async (entry: LibraryEntry, title: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const updated = await window.readingTime.library.update(entry.id, { title })
        if (!updated) return { ok: false, error: '文档已不在书架中。' }
        setEntries((current) =>
          current.map((candidate) => (candidate.id === updated.id ? updated : candidate))
        )
        showToast('书名已更新。', 'success')
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '重命名失败。' }
      }
    },
    [showToast]
  )

  const deleteEntry = useCallback(
    async (entry: LibraryEntry): Promise<{ ok: boolean; error?: string }> => {
      try {
        const result = await window.readingTime.library.remove(entry.id)
        if (!result.ok) return { ok: false, error: result.error || '删除失败。' }
        const remaining = entriesRef.current.filter((candidate) => candidate.id !== entry.id)
        setEntries(remaining)
        if (selectedIdRef.current === entry.id) {
          setSelectedId(remaining[0]?.id ?? null)
        }
        showToast(`《${entry.title}》已从书架删除。`, 'success')
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '删除失败。' }
      }
    },
    [showToast]
  )

  commandHandlerRef.current = (command: AppCommand): void => {
    if (command.type === 'import') {
      openImportDialog()
    } else if (command.type === 'settings') {
      setSettingsOpen(true)
    } else if (command.type === 'import-paths') {
      importPaths(command.paths)
    }
  }

  useEffect(() => {
    return window.readingTime.app.onCommand((command) => commandHandlerRef.current(command))
  }, [])

  useEffect(() => {
    if (bootStatus === 'ready') {
      void window.readingTime.app.ready().catch(() => showToast('打开文件服务未就绪，请重新打开应用。', 'error'))
    }
  }, [bootStatus, showToast])

  useEffect(() => {
    const onDragEnter = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      dragDepthRef.current += 1
      setDragging(true)
    }
    const onDragOver = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (event: DragEvent): void => {
      if (dragDepthRef.current === 0) return
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) setDragging(false)
    }
    const resetDrag = (): void => {
      dragDepthRef.current = 0
      setDragging(false)
    }
    const onDrop = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      dragDepthRef.current = 0
      setDragging(false)
      const files = Array.from(event.dataTransfer.files)
      const paths: string[] = []
      for (const file of files) {
        try {
          const path = window.readingTime.app.getPathForFile(file)
          if (path && path.toLowerCase().endsWith('.pdf')) paths.push(path)
        } catch (error) {
          console.warn('[app] Could not resolve dropped file path.', error)
        }
      }
      if (!paths.length) {
        showToast('请拖入 PDF 文件。', 'error')
        return
      }
      importPaths(paths)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragend', resetDrag)
    window.addEventListener('blur', resetDrag)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', resetDrag)
      window.removeEventListener('blur', resetDrag)
    }
  }, [importPaths, showToast])

  if (bootStatus === 'loading' || (bootStatus === 'ready' && !settings)) {
    return (
      <div className="app-frame">
        <Titlebar />
        <div className="boot-screen">
          <div className="boot-mark">译</div>
          <span className="eyebrow">READING TIME</span>
          <h1>正在整理你的书架</h1>
          <p>把阅读留在本机，把对话交给模型。</p>
          <div className="boot-progress">
            <span />
          </div>
        </div>
      </div>
    )
  }

  if (bootStatus === 'error' || !settings) {
    return (
      <div className="app-frame">
        <Titlebar />
        <div className="boot-screen boot-error">
          <span className="boot-error-icon">
            <Icon name="alert" size={24} />
          </span>
          <span className="eyebrow">SOMETHING WENT WRONG</span>
          <h1>书架没有顺利打开</h1>
          <p>{bootError}</p>
          <button type="button" className="primary-button" onClick={() => void boot()}>
            <Icon name="refresh" size={16} />
            再试一次
          </button>
        </div>
      </div>
    )
  }

  const currentEntry =
    selectedEntry && settings ? selectedEntry : null

  return (
    <div className={cn('app-frame', !sidebarVisible && 'sidebar-hidden')}>
      <Titlebar />
      <div className="workspace">
        {sidebarVisible ? (
          <ResizableSidebar>
            <LibrarySidebar
              entries={entries}
              selectedId={selectedId}
              importing={importing}
              settings={settings}
              version={version}
              onSelect={selectEntry}
              onImport={openImportDialog}
              onRename={(entry) => setDialog({ type: 'rename', entry })}
              onDelete={(entry) => setDialog({ type: 'delete', entry })}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </ResizableSidebar>
        ) : null}
        <div className="main-stage">
          {currentEntry ? (
            <PdfReader
              key={currentEntry.id}
              entry={currentEntry}
              settings={settings}
              sidebarVisible={sidebarVisible}
              onToggleSidebar={() => setSidebarVisible((visible) => !visible)}
              onProgress={handleProgress}
              onOpenSettings={() => setSettingsOpen(true)}
              onUpdatePreferences={updatePreferences}
              onChangeTargetLanguage={changeTargetLanguage}
            />
          ) : (
            <EmptyState
              settings={settings}
              importing={importing}
              onImport={openImportDialog}
              onOpenSettings={() => setSettingsOpen(true)}
              onShowLibrary={() => setSidebarVisible(true)}
              libraryVisible={sidebarVisible}
            />
          )}
        </div>
      </div>

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={saveAllSettings}
      />
      <DocumentDialogs
        dialog={dialog}
        onClose={() => setDialog(null)}
        onRename={renameEntry}
        onDelete={deleteEntry}
      />
      <Toast toast={toast} onDismiss={dismissToast} />

      {dragging ? (
        <div className="drop-overlay" data-selection-ignore="true">
          <div className="drop-card">
            <span className="drop-icon">
              <Icon name="plus" size={26} />
            </span>
            <h2>把 PDF 放到书架上</h2>
            <p>松开鼠标，导入后就可以开始阅读。</p>
            <span className="drop-hint">文件会复制到本机专属资料库</span>
          </div>
        </div>
      ) : null}

      {importing && !dragging ? (
        <div className="import-pill" role="status">
          <span className="small-spinner" />
          正在导入 PDF…
        </div>
      ) : null}
    </div>
  )
}

function Titlebar(): React.JSX.Element {
  return (
    <div className="titlebar" aria-hidden="true">
      <div className="titlebar-brand">
        <span className="titlebar-mark">译</span>
        <span className="titlebar-name">阅读时光</span>
        <span className="titlebar-divider" />
        <span className="titlebar-tagline">READING TIME</span>
      </div>
      <div className="titlebar-right">
        <span className="titlebar-local-dot" />
        <span>本地书架 · 私密翻译</span>
      </div>
    </div>
  )
}
