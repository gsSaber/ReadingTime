import type { AppSettings } from '@shared/types'
import { Icon } from './Icon'
import { cn } from '../lib/format'

interface EmptyStateProps {
  settings: AppSettings
  importing: boolean
  onImport: () => void
  onOpenSettings: () => void
  onShowLibrary: () => void
  libraryVisible: boolean
}

export function EmptyState({
  settings,
  importing,
  onImport,
  onOpenSettings,
  onShowLibrary,
  libraryVisible
}: EmptyStateProps): React.JSX.Element {
  const modelReady = Boolean(settings.llm.baseUrl && settings.llm.modelId)
  return (
    <main className="empty-view">
      {!libraryVisible ? (
        <button type="button" className="floating-library-button" onClick={onShowLibrary}>
          <Icon name="library" size={16} />
          打开书架
        </button>
      ) : null}
      <div className="empty-hero">
        <div className="empty-copy">
          <div className="empty-eyebrow">
            <span className="eyebrow-line" />
            <span>YOUR QUIET READING ROOM</span>
          </div>
          <h1>
            让世界，
            <br />
            <em>慢下来一页。</em>
          </h1>
          <p className="empty-lead">
            把 PDF 交给阅读时光。选中一句话，松开鼠标，
            <br className="wide-only" />
            译文就会安静地出现在你手边。
          </p>

          <div className="empty-actions">
            <button
              type="button"
              className="primary-button large"
              onClick={onImport}
              disabled={importing}
            >
              {importing ? <span className="small-spinner" /> : <Icon name="plus" size={18} />}
              {importing ? '正在导入…' : '导入第一份 PDF'}
            </button>
            <button type="button" className="secondary-button large" onClick={onOpenSettings}>
              <Icon name="settings" size={17} />
              配置模型
            </button>
          </div>

          <button type="button" className={cn('model-readiness', modelReady && 'is-ready')} onClick={onOpenSettings}>
            <span className={cn('status-dot', modelReady ? 'is-ready' : 'is-warning')} />
            <span>
              {modelReady
                ? `划词翻译已就绪 · ${settings.llm.targetLanguage}`
                : '还差一步：配置翻译模型'}
            </span>
            <Icon name="chevron-right" size={14} />
          </button>
        </div>

        <div className="empty-visual" aria-hidden="true">
          <div className="visual-glow" />
          <div className="paper-stack paper-stack-back" />
          <div className="paper-stack paper-stack-mid" />
          <article className="hero-paper">
            <div className="hero-paper-topline">
              <span>CHAPTER 03</span>
              <span>— 12 —</span>
            </div>
            <h2>The art of<br />reading slowly.</h2>
            <div className="paper-rule" />
            <p>
              Reading is a conversation<br />
              between two minds, across<br />
              time and distance.
            </p>
            <div className="paper-lines">
              <span />
              <span />
              <span />
            </div>
            <div className="hero-selection">
              between two minds,<br />across time
              <span className="selection-handle" />
            </div>
          </article>
          <div className="hero-translation-card">
            <div className="translation-card-head">
              <span className="mini-spark">
                <Icon name="sparkles" size={12} />
              </span>
              <span>译 · 简体中文</span>
              <span className="translation-card-live">LIVE</span>
            </div>
            <p>阅读，是两颗心灵跨越时间与距离的对话。</p>
            <div className="translation-card-foot">
              <span>松开鼠标，自动翻译</span>
              <span className="translation-loader-dots">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
          <span className="visual-note visual-note-one">选中</span>
          <span className="visual-note visual-note-two">理解</span>
        </div>
      </div>

      <div className="empty-features">
        <div className="empty-feature">
          <span className="feature-icon warm">
            <Icon name="translate" size={18} />
          </span>
          <div>
            <strong>划词即译</strong>
            <span>松开鼠标，译文自动浮现</span>
          </div>
        </div>
        <div className="empty-feature">
          <span className="feature-icon sage">
            <Icon name="library" size={18} />
          </span>
          <div>
            <strong>私人书架</strong>
            <span>导入、整理、继续上次阅读</span>
          </div>
        </div>
        <div className="empty-feature">
          <span className="feature-icon ink">
            <Icon name="book" size={18} />
          </span>
          <div>
            <strong>专注排版</strong>
            <span>适宽缩放、目录与三种纸面主题</span>
          </div>
        </div>
      </div>

      <footer className="empty-footer">
        <span>把 PDF 拖进窗口，也可以导入</span>
        <span className="empty-footer-dot" />
        <span>文件与阅读记录只留在本机</span>
      </footer>
    </main>
  )
}
