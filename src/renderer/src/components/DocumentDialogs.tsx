import { useEffect, useState } from 'react'
import type { LibraryEntry } from '@shared/types'
import { Icon } from './Icon'
import { Modal, ModalCloseButton } from './Modal'

export type DocumentDialogState =
  | { type: 'rename'; entry: LibraryEntry }
  | { type: 'delete'; entry: LibraryEntry }
  | null

interface DocumentDialogsProps {
  dialog: DocumentDialogState
  onClose: () => void
  onRename: (entry: LibraryEntry, title: string) => Promise<{ ok: boolean; error?: string }>
  onDelete: (entry: LibraryEntry) => Promise<{ ok: boolean; error?: string }>
}

export function DocumentDialogs({
  dialog,
  onClose,
  onRename,
  onDelete
}: DocumentDialogsProps): React.JSX.Element | null {
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!dialog) return
    if (dialog.type === 'rename') setTitle(dialog.entry.title)
    setError('')
    setBusy(false)
  }, [dialog])

  if (!dialog) return null

  const submitRename = async (): Promise<void> => {
    const cleaned = title.trim()
    if (!cleaned) {
      setError('书名不能为空。')
      return
    }
    setBusy(true)
    const result = await onRename(dialog.entry, cleaned)
    setBusy(false)
    if (!result.ok) {
      setError(result.error || '重命名失败。')
      return
    }
    onClose()
  }

  const submitDelete = async (): Promise<void> => {
    setBusy(true)
    const result = await onDelete(dialog.entry)
    setBusy(false)
    if (!result.ok) {
      setError(result.error || '删除失败。')
      return
    }
    onClose()
  }

  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose()
      }}
      className="small-modal"
      ariaLabel={dialog.type === 'rename' ? '重命名文档' : '删除文档'}
    >
      {dialog.type === 'rename' ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submitRename()
          }}
        >
          <header className="small-modal-header">
            <div>
              <span className="eyebrow">LIBRARY</span>
              <h2>重命名这本书</h2>
            </div>
            <ModalCloseButton onClick={onClose} />
          </header>
          <p className="small-modal-description">
            只修改书架中的显示名称，不会改动 PDF 文件内容。
          </p>
          <label className="field">
            <span>书名</span>
            <input
              type="text"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value)
                setError('')
              }}
              maxLength={180}
              data-autofocus
            />
          </label>
          {error ? <p className="inline-error">{error}</p> : null}
          <footer className="small-modal-footer">
            <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button type="submit" className="primary-button" disabled={busy || !title.trim()}>
              {busy ? '保存中…' : '保存书名'}
            </button>
          </footer>
        </form>
      ) : (
        <div>
          <header className="small-modal-header">
            <div>
              <span className="eyebrow">LIBRARY</span>
              <h2>从书架删除？</h2>
            </div>
            <ModalCloseButton onClick={onClose} />
          </header>
          <div className="delete-summary">
            <span className="delete-icon">
              <Icon name="trash" size={20} />
            </span>
            <div>
              <strong>《{dialog.entry.title}》</strong>
              <p>保存在本机的副本和阅读进度会被移除。该操作无法撤销。</p>
            </div>
          </div>
          {error ? <p className="inline-error">{error}</p> : null}
          <footer className="small-modal-footer">
            <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button
              type="button"
              className="danger-button"
              onClick={() => void submitDelete()}
              disabled={busy}
              data-autofocus
            >
              {busy ? '正在删除…' : '删除这本书'}
            </button>
          </footer>
        </div>
      )}
    </Modal>
  )
}
