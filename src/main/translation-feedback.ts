import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { SelectionContext, TranslationMode } from '../shared/types'

interface TranslationSnapshot {
  appVersion: string
  source: string
  text: string
  context?: SelectionContext
  targetLanguage: string
  modelId: string
  mode: TranslationMode
  runtimeId?: string
  runtimeVersion?: string
  strategyVersion?: string
}

export class TranslationFeedback {
  private directory: string
  private recent = new WeakMap<WebContents, Map<string, TranslationSnapshot>>()

  constructor(dataPath: string) {
    this.directory = join(dataPath, 'data', 'translation-feedback')
  }

  remember(sender: WebContents, snapshot: TranslationSnapshot): string {
    let results = this.recent.get(sender)
    if (!results) {
      results = new Map()
      this.recent.set(sender, results)
    }
    // Keep unrated selections in memory only. Allow overlapping requests to finish out of order.
    if (results.size >= 16) results.delete(results.keys().next().value!)
    const id = randomUUID()
    results.set(id, snapshot)
    return id
  }

  save(sender: WebContents, id: unknown, vote: unknown, reason: unknown): { ok: boolean; error?: string } {
    const snapshot = typeof id === 'string' && this.recent.get(sender)?.get(id)
    if (!snapshot || typeof id !== 'string') return { ok: false, error: '这条结果已过期，请重新翻译后评价。' }
    if (vote !== 'up' && vote !== 'down' && vote !== null) return { ok: false, error: '评价无效。' }
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1000)) {
      return { ok: false, error: '理由最多可填写 1000 字。' }
    }
    const file = join(this.directory, id + '.json')
    try {
      if (vote === null) {
        rmSync(file, { force: true })
      } else {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 })
        const record = { id, ...snapshot, vote, reason: vote === 'down' ? reason?.trim() || '' : '', updatedAt: Date.now() }
        writeFileSync(file + '.tmp', JSON.stringify(record), { mode: 0o600 })
        renameSync(file + '.tmp', file)
      }
      return { ok: true }
    } catch {
      return { ok: false, error: '反馈保存失败，请检查存储空间和权限后重试。' }
    }
  }
}
