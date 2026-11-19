import { useEffect, useMemo, useRef, useState } from 'react'
import type { OutlineItem } from '../lib/pdf'
import { countOutlineItems } from '../lib/pdf'
import { cn } from '../lib/format'
import { Icon } from './Icon'

interface OutlineDrawerProps {
  open: boolean
  loading: boolean
  items: OutlineItem[]
  currentPage: number
  onSelectPage: (page: number) => void
  onClose: () => void
}

function matchesQuery(item: OutlineItem, needle: string): boolean {
  if (item.title.toLowerCase().includes(needle)) return true
  return item.children.some((child) => matchesQuery(child, needle))
}

function currentChapterId(items: OutlineItem[], currentPage: number): string | null {
  let bestPage = -1
  let bestId: string | null = null
  const visit = (nodes: OutlineItem[]): void => {
    for (const node of nodes) {
      if (node.page && node.page <= currentPage && node.page >= bestPage) {
        bestPage = node.page
        bestId = node.id
      }
      visit(node.children)
    }
  }
  visit(items)
  return bestId
}

function OutlineNode({
  item,
  currentPage,
  currentChapter,
  onSelectPage
}: {
  item: OutlineItem
  currentPage: number
  currentChapter: string | null
  onSelectPage: (page: number) => void
}): React.JSX.Element {
  const active = item.id === currentChapter
  return (
    <li className={cn('outline-node', `level-${item.level}`)}>
      <button
        type="button"
        className={cn('outline-row', active && 'is-active')}
        data-outline-current={active || undefined}
        disabled={!item.page}
        onClick={() => item.page && onSelectPage(item.page)}
        style={{ paddingLeft: `${14 + item.level * 16}px` }}
      >
        <span className="outline-title">{item.title}</span>
        {item.page ? <span className="outline-page">{item.page}</span> : null}
      </button>
      {item.children.length ? (
        <ul>
          {item.children.map((child) => (
            <OutlineNode
              key={child.id}
              item={child}
              currentPage={currentPage}
              currentChapter={currentChapter}
              onSelectPage={onSelectPage}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function OutlineDrawer({
  open,
  loading,
  items,
  currentPage,
  onSelectPage,
  onClose
}: OutlineDrawerProps): React.JSX.Element {
  const count = countOutlineItems(items)
  const [query, setQuery] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const currentChapter = useMemo(() => currentChapterId(items, currentPage), [items, currentPage])

  const visibleItems = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return items
    return items.filter((item) => matchesQuery(item, needle))
  }, [items, query])

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => {
      const current = scrollRef.current?.querySelector<HTMLElement>('[data-outline-current]')
      current?.scrollIntoView({ block: 'center' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  return (
    <div
      className={cn('outline-layer', open && 'is-open')}
      data-selection-ignore="true"
      aria-hidden={!open}
      inert={!open}
    >
      <button
        type="button"
        className="outline-backdrop"
        onClick={onClose}
        tabIndex={open ? 0 : -1}
        aria-label="关闭目录"
      />
      <aside className="outline-drawer" aria-label="PDF 目录">
        <header className="outline-head">
          <div>
            <span className="eyebrow">CONTENTS</span>
            <h2>目录</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭目录">
            <Icon name="x" size={18} />
          </button>
        </header>
        <div className="outline-summary">
          <span>{count ? `${count} 个章节` : loading ? '正在读取目录' : '这份 PDF 没有内嵌目录'}</span>
          <span className="outline-current">第 {currentPage} 页</span>
        </div>
        {count > 8 ? (
          <label className="outline-search">
            <Icon name="search" size={14} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索章节"
              aria-label="搜索目录章节"
            />
            {query ? (
              <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="清空章节搜索">
                <Icon name="x" size={12} />
              </button>
            ) : null}
          </label>
        ) : null}
        <div className="outline-scroll" ref={scrollRef}>
          {loading ? (
            <div className="outline-loading">
              <span className="small-spinner" />
              正在整理章节…
            </div>
          ) : items.length ? (
            visibleItems.length ? (
              <ul className="outline-list">
                {visibleItems.map((item) => (
                  <OutlineNode
                    key={item.id}
                    item={item}
                    currentPage={currentPage}
                    currentChapter={currentChapter}
                    onSelectPage={(page) => {
                      onSelectPage(page)
                      onClose()
                    }}
                  />
                ))}
              </ul>
            ) : (
              <div className="outline-empty">
                <strong>没有匹配的章节</strong>
                <p>试试更短的关键词，或清空搜索查看完整目录。</p>
              </div>
            )
          ) : (
            <div className="outline-empty">
              <span className="outline-empty-icon">
                <Icon name="list" size={22} />
              </span>
              <strong>没有找到章节目录</strong>
              <p>你仍然可以使用工具栏的页码跳转，或直接滚动阅读。</p>
            </div>
          )}
        </div>
        <footer className="outline-foot">
          <span>章节来自 PDF 内嵌书签</span>
          <button type="button" className="text-button" onClick={() => onSelectPage(1)}>
            回到第一页
          </button>
        </footer>
      </aside>
    </div>
  )
}
