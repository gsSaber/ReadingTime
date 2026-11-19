import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, LibraryEntry } from '@shared/types'
import { Icon } from './Icon'
import { cn, formatFileSize, formatRelativeDate, progressPercent } from '../lib/format'

interface LibrarySidebarProps {
  entries: LibraryEntry[]
  selectedId: string | null
  importing: boolean
  settings: AppSettings
  version: string
  onSelect: (entry: LibraryEntry) => void
  onImport: () => void
  onRename: (entry: LibraryEntry) => void
  onDelete: (entry: LibraryEntry) => void
  onOpenSettings: () => void
}

const COVER_PALETTES = [
  ['#75413b', '#3f2422'],
  ['#42584c', '#24332b'],
  ['#5d4e78', '#30283f'],
  ['#755b35', '#3f301c'],
  ['#345969', '#1d333b'],
  ['#6b4655', '#37212a']
]

function coverPalette(id: string): [string, string] {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0
  }
  return COVER_PALETTES[hash % COVER_PALETTES.length] as [string, string]
}

function BookCover({ entry }: { entry: LibraryEntry }): React.JSX.Element {
  const [from, to] = coverPalette(entry.id)
  const progress = progressPercent(entry)
  const initial = entry.title.trim().slice(0, 1) || '书'
  return (
    <div
      className="book-cover"
      style={{ background: `linear-gradient(145deg, ${from}, ${to})` }}
      aria-hidden="true"
    >
      <span className="book-cover-initial">{initial}</span>
      <span className="book-cover-label">{progress >= 100 ? '读完' : 'PDF'}</span>
      {progress > 0 ? (
        <span className="book-cover-progress" style={{ width: `${progress}%` }} />
      ) : null}
    </div>
  )
}

type SortMode = 'recent' | 'added' | 'progress' | 'title'
type StatusFilter = 'all' | 'reading' | 'finished' | 'unread'

const SORT_KEY = 'reading-time:library-sort'
const FILTER_KEY = 'reading-time:library-filter'
const SORT_OPTIONS: Array<{ id: SortMode; label: string }> = [
  { id: 'recent', label: '最近阅读' },
  { id: 'added', label: '最近导入' },
  { id: 'progress', label: '阅读进度' },
  { id: 'title', label: '书名' }
]
const FILTER_OPTIONS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'reading', label: '在读' },
  { id: 'finished', label: '读完' },
  { id: 'unread', label: '未读' }
]

function storedChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const stored = localStorage.getItem(key)
  return stored && (allowed as readonly string[]).includes(stored) ? (stored as T) : fallback
}

export function LibrarySidebar({
  entries,
  selectedId,
  importing,
  settings,
  version,
  onSelect,
  onImport,
  onRename,
  onDelete,
  onOpenSettings
}: LibrarySidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [menuId, setMenuId] = useState<string | null>(null)
  const [sortMode, setSortMode] = useState<SortMode>(() =>
    storedChoice(SORT_KEY, SORT_OPTIONS.map((option) => option.id), 'recent')
  )
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() =>
    storedChoice(FILTER_KEY, FILTER_OPTIONS.map((option) => option.id), 'all')
  )
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = entries.filter((entry) => {
      if (needle && !entry.title.toLowerCase().includes(needle)) return false
      const progress = progressPercent(entry)
      if (statusFilter === 'finished') return entry.pageCount > 0 && progress >= 100
      if (statusFilter === 'reading') return entry.pageCount > 0 && progress > 0 && progress < 100
      if (statusFilter === 'unread') return entry.pageCount === 0 || progress === 0
      return true
    })
    return matches.sort((a, b) => {
      if (sortMode === 'added') return b.addedAt - a.addedAt
      if (sortMode === 'progress') return progressPercent(b) - progressPercent(a)
      if (sortMode === 'title') return a.title.localeCompare(b.title, 'zh-CN')
      return (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt)
    })
  }, [entries, query, sortMode, statusFilter])

  useEffect(() => {
    localStorage.setItem(SORT_KEY, sortMode)
  }, [sortMode])

  useEffect(() => {
    localStorage.setItem(FILTER_KEY, statusFilter)
  }, [statusFilter])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const withModifier = event.metaKey || event.ctrlKey
      if (withModifier && event.key.toLowerCase() === 'f' && !event.shiftKey && !event.altKey) {
        if (document.querySelector('.modal-layer')) return
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const modelReady = Boolean(settings.llm.baseUrl && settings.llm.modelId)

  useEffect(() => {
    if (!menuId) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest(`[data-menu-root="${menuId}"]`)) return
      setMenuId(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuId(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuId])

  useEffect(() => {
    if (!selectedId || !listRef.current) return
    const selected = listRef.current.querySelector<HTMLElement>(`[data-entry-id="${selectedId}"]`)
    selected?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  return (
    <aside className="library-sidebar">
      <div className="sidebar-actions">
        <div className="sidebar-kicker">
          <span>私人书架</span>
          <span className="library-count">{entries.length}</span>
        </div>
        <button
          type="button"
          className="import-button"
          onClick={onImport}
          disabled={importing}
        >
          {importing ? <span className="small-spinner" /> : <Icon name="plus" size={17} />}
          <span>{importing ? '正在导入…' : '导入 PDF'}</span>
          <span className="shortcut-hint">⌘ O</span>
        </button>
        <label className={cn('search-box', !entries.length && 'is-disabled')}>
          <Icon name="search" size={15} />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.preventDefault()
                event.stopPropagation()
                setQuery('')
              }
            }}
            placeholder="搜索书架"
            disabled={!entries.length}
            aria-label="搜索 PDF 资料库"
          />
          {query ? (
            <button
              type="button"
              className="search-clear"
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
              aria-label="清空搜索"
            >
              <Icon name="x" size={12} />
            </button>
          ) : entries.length ? (
            <span className="search-shortcut" aria-hidden="true">⌘F</span>
          ) : null}
        </label>
        {entries.length > 1 ? (
          <div className="library-controls">
            <label className="library-sort">
              <span className="visually-hidden">排序方式</span>
              <select
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as SortMode)}
                aria-label="排序方式"
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" size={12} />
            </label>
            <div className="library-filters" role="group" aria-label="按阅读状态筛选">
              {FILTER_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={cn(statusFilter === option.id && 'is-active')}
                  aria-pressed={statusFilter === option.id}
                  onClick={() => setStatusFilter(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="library-list" ref={listRef}>
        {filteredEntries.map((entry) => {
          const progress = progressPercent(entry)
          const active = entry.id === selectedId
          return (
            <article
              key={entry.id}
              data-entry-id={entry.id}
              className={cn('doc-entry', active && 'is-active')}
              onClick={() => onSelect(entry)}
              role="button"
              tabIndex={0}
              aria-current={active ? 'true' : undefined}
              aria-label={`打开《${entry.title}》`}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(entry)
                }
              }}
            >
              <BookCover entry={entry} />
              <div className="doc-entry-body">
                <h3 title={entry.title}>{entry.title}</h3>
                <div className="doc-meta-row">
                  <span>
                    {entry.pageCount > 0 ? `${entry.pageCount} 页` : '尚未打开'}
                    {entry.pageCount > 0 ? ` · ${progress}%` : ''}
                  </span>
                  <span className="doc-size">{formatFileSize(entry.size)}</span>
                </div>
                <div className="doc-progress" aria-hidden="true">
                  {progress > 0 ? <span style={{ width: `${progress}%` }} /> : null}
                </div>
                <p className="doc-last-opened">
                  {progress >= 100 && entry.pageCount > 0 ? (
                    <span className="doc-finished-tag">已读完</span>
                  ) : entry.lastPage > 1 && entry.pageCount > 0 ? (
                    `读到第 ${entry.lastPage} 页`
                  ) : (
                    formatRelativeDate(entry.openedAt || entry.addedAt)
                  )}
                </p>
              </div>
              <div className="doc-actions" data-menu-root={entry.id}>
                <button
                  type="button"
                  className="icon-button subtle doc-menu-trigger"
                  aria-label={`管理《${entry.title}》`}
                  aria-expanded={menuId === entry.id}
                  onClick={(event) => {
                    event.stopPropagation()
                    setMenuId((current) => (current === entry.id ? null : entry.id))
                  }}
                >
                  <Icon name="more" size={17} />
                </button>
                {menuId === entry.id ? (
                  <div className="doc-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={(event) => {
                        event.stopPropagation()
                        setMenuId(null)
                        onRename(entry)
                      }}
                    >
                      <Icon name="edit" size={15} />
                      重命名
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="is-danger"
                      onClick={(event) => {
                        event.stopPropagation()
                        setMenuId(null)
                        onDelete(entry)
                      }}
                    >
                      <Icon name="trash" size={15} />
                      从书架删除
                    </button>
                  </div>
                ) : null}
              </div>
            </article>
          )
        })}

        {entries.length === 0 ? (
          <div className="sidebar-empty">
            <p>书架还是空的。</p>
            <span>导入第一份 PDF，开始安静地阅读。</span>
          </div>
        ) : null}

        {entries.length > 0 && filteredEntries.length === 0 ? (
          <div className="sidebar-empty">
            <p>{query ? `没有找到“${query}”。` : '这个分类下还没有书。'}</p>
            <span>
              {query ? '换一个关键词试试。' : '换一个筛选条件看看。'}
              {query || statusFilter !== 'all' ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setQuery('')
                      setStatusFilter('all')
                    }}
                  >
                    清除筛选
                  </button>
                </>
              ) : null}
            </span>
          </div>
        ) : null}
      </div>

      <div className="sidebar-footer">
        <button type="button" className="model-status" onClick={onOpenSettings}>
          <span className={cn('status-dot', modelReady ? 'is-ready' : 'is-warning')} />
          <span className="model-status-copy">
            <strong>{modelReady ? settings.llm.modelId : '配置翻译模型'}</strong>
            <small>
              {modelReady
                ? `划词即译 · ${settings.llm.targetLanguage}`
                : '填写 Base URL 与模型 ID'}
            </small>
          </span>
          <Icon name="settings" size={16} />
        </button>
        <div className="sidebar-footnote">
          <span>本地存储</span>
          <span>v{version || '1.0.0'}</span>
        </div>
      </div>
    </aside>
  )
}
