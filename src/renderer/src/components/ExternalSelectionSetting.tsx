import { useEffect, useState } from 'react'
import type { ExternalStatus } from '@shared/types'
import { Toggle } from './Modal'

export function ExternalSelectionSetting({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }): React.JSX.Element | null {
  const [status, setStatus] = useState<ExternalStatus>()
  useEffect(() => {
    let mounted = true
    const read = () => void window.readingTime.external.status().then(value => { if (mounted) setStatus(value) })
    read()
    const timer = window.setInterval(read, 2500)
    return () => { mounted = false; window.clearInterval(timer) }
  }, [])
  if (!status?.supported) return null
  return <section className="form-section">
    <Toggle checked={enabled} onChange={onChange} label="跨应用划词翻译"
      description="在其他应用划选或双击文字时显示译文。选中文字及查词所需的附近语境会发送到当前模型服务。" />
    {enabled && <div className="external-selection-help">
      {!status.trusted && <button type="button" className="secondary-button" onClick={async () => setStatus(await window.readingTime.external.authorize())}>授权 macOS 辅助功能</button>}
      <p>{status.error || (!status.trusted ? '请在系统设置的「隐私与安全性 → 辅助功能」中允许阅读时光。' :
        status.monitoring ? '跨应用划词已启用。' : '保存设置后开始监听划词。')}</p>
      <p>应用无法提供选区时，复制文字后{status.shortcut ? '按 ⌘⌥T' : '在阅读时光中选择「编辑 → 粘贴翻译」'}，粘贴并确认翻译。</p>
    </div>}
  </section>
}
