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
      <span className="book-cover-label">PDF</span>
      <span className="book-cover-progress" style={{ width: `${Math.max(3, progress)}%` }} />
    </div>
  )
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
  const listRef = useRef<HTMLDivElement>(null)

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return entries
    return entries.filter((entry) => entry.title.toLowerCase().includes(needle))
  }, [entries, query])

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
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索书架"
            disabled={!entries.length}
            aria-label="搜索 PDF 资料库"
          />
          {query ? (
            <button
              type="button"
              className="search-clear"
              onClick={() => setQuery('')}
              aria-label="清空搜索"
            >
              <Icon name="x" size={12} />
            </button>
          ) : null}
        </label>
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
                  <span style={{ width: `${progress}%` }} />
                </div>
                <p className="doc-last-opened">
                  {entry.lastPage > 1 && entry.pageCount > 0
                    ? `读到第 ${entry.lastPage} 页`
                    : formatRelativeDate(entry.openedAt || entry.addedAt)}
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
            <p>没有找到“{query}”。</p>
            <span>换一个关键词试试。</span>
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
