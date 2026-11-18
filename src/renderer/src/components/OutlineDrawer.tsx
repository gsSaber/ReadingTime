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

function OutlineNode({
  item,
  currentPage,
  onSelectPage
}: {
  item: OutlineItem
  currentPage: number
  onSelectPage: (page: number) => void
}): React.JSX.Element {
  const active = item.page === currentPage
  return (
    <li className={cn('outline-node', `level-${item.level}`)}>
      <button
        type="button"
        className={cn('outline-row', active && 'is-active')}
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
        <div className="outline-scroll">
          {loading ? (
            <div className="outline-loading">
              <span className="small-spinner" />
              正在整理章节…
            </div>
          ) : items.length ? (
            <ul className="outline-list">
              {items.map((item) => (
                <OutlineNode
                  key={item.id}
                  item={item}
                  currentPage={currentPage}
                  onSelectPage={(page) => {
                    onSelectPage(page)
                    onClose()
                  }}
                />
              ))}
            </ul>
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
