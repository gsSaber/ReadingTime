import type { ConnectionTestResult, TranslateInput, TranslateResult, TranslationRuntimeStatus, TranslationUpdateResult } from '../shared/types'
import { WorkerClient, type WorkerFactory } from './client.ts'
import type { ConnectionConfig } from './protocol'
import { ReleaseStore, type Release, type ReleaseState } from './releases.ts'
import { validateCandidate } from './validation.ts'

export class TranslationRuntime {
  private current?: WorkerClient
  private state: ReleaseState = { active: 'builtin', previous: null }
  private lastError?: string
  private queue: Promise<unknown> = Promise.resolve()
  private starting?: Promise<void>
  private clients = new Set<WorkerClient>()
  private closed = false

  readonly store: ReleaseStore
  private factory: WorkerFactory
  constructor(store: ReleaseStore, factory: WorkerFactory) { this.store = store; this.factory = factory }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => {})
    return result
  }

  initialize(): Promise<void> {
    if (this.current) return Promise.resolve()
    if (this.closed) return Promise.reject(new Error('翻译模块已关闭。'))
    if (!this.starting) {
      this.starting = this.serialized(async () => {
        if (this.current) return
        try { this.state = this.store.readState() } catch { this.lastError = '版本记录损坏，已恢复内置翻译。'; this.state = { active: 'builtin', previous: null } }
        const ids = [...new Set([this.state.active, this.state.previous, 'builtin'].filter((id): id is string => Boolean(id)))]
        for (const id of ids) {
          try {
            const client = await this.prepare(this.store.get(id))
            if (id !== this.state.active) {
              this.state = { active: id, previous: null }
              try { this.store.saveState(this.state) } catch { this.lastError = '已恢复可用翻译，但版本记录保存失败。' }
            }
            this.current = client
            return
          } catch { this.lastError = '翻译模块无法启动，已尝试恢复可用版本。' }
        }
        throw new Error('无法启动翻译模块。')
      }).finally(() => { this.starting = undefined })
    }
    return this.starting
  }

  private async prepare(release: Release): Promise<WorkerClient> {
    if (this.closed) throw new Error('翻译模块已关闭。')
    let client: WorkerClient
    client = new WorkerClient(release, this.factory, () => {
      this.clients.delete(client)
      if (this.current !== client || this.closed) return
      this.current = undefined
      this.state = { active: this.state.previous ?? 'builtin', previous: null }
      this.lastError = '翻译进程意外退出，后续请求将恢复到可用版本。'
      try { this.store.saveState(this.state) } catch { this.lastError += '版本记录保存失败。' }
    })
    this.clients.add(client)
    try {
      await client.ready
      await validateCandidate(client)
      if (this.closed) throw new Error('翻译模块已关闭。')
      return client
    } catch (error) { client.stop(); throw error }
  }

  status(): TranslationRuntimeStatus {
    const release = this.current?.release
    return { id: release?.id ?? '', version: release?.version ?? 'unavailable', strategyVersion: release?.strategy.version ?? '',
      builtin: this.state.active === 'builtin', canRollback: Boolean(this.state.previous), ...(this.lastError ? { lastError: this.lastError } : {}) }
  }

  private async switchTo(release: Release): Promise<void> {
    if (this.current?.release.id === release.id) return
    const candidate = await this.prepare(release)
    const previous = this.current
    const next: ReleaseState = { active: release.id, previous: previous?.release.id ?? null }
    // Persist before adoption: a failed disk write leaves the live version untouched.
    try { this.store.saveState(next) } catch (error) { candidate.stop(); throw error }
    this.state = next
    this.current = candidate
    this.lastError = undefined
    previous?.retire()
  }

  private async update(operation: () => Promise<void>): Promise<TranslationUpdateResult> {
    try { await this.initialize(); await this.serialized(operation); return { ok: true, status: this.status() } }
    catch (error) { return { ok: false, status: this.status(), error: error instanceof Error ? error.message : '翻译更新失败。' } }
  }

  install(path: string): Promise<TranslationUpdateResult> { return this.update(async () => this.switchTo(this.store.import(path, this.current?.release))) }
  rollback(): Promise<TranslationUpdateResult> {
    return this.update(async () => {
      if (!this.state.previous) throw new Error('暂无可回滚版本。')
      await this.switchTo(this.store.get(this.state.previous))
    })
  }
  restoreBuiltin(): Promise<TranslationUpdateResult> { return this.update(async () => this.switchTo(this.store.builtin)) }

  async translate(input: TranslateInput, config: ConnectionConfig, onDelta: (text: string) => void, signal?: AbortSignal): Promise<TranslateResult> {
    await this.initialize()
    const client = this.current!
    const result = await client.request('translate', config, input, onDelta, signal) as TranslateResult
    if (!result || typeof result.ok !== 'boolean') throw new Error('翻译模块返回了无效结果。')
    return { ...result, runtimeId: client.release.id, runtimeVersion: client.release.version, strategyVersion: client.release.strategy.version }
  }

  async testConnection(config: ConnectionConfig): Promise<ConnectionTestResult> {
    await this.initialize()
    const result = await this.current!.request('test', config) as ConnectionTestResult & TranslateResult
    return typeof result.message === 'string' ? result : { ok: false, message: result.error?.message ?? '连接测试失败。' }
  }

  close(): void {
    this.closed = true
    this.current = undefined
    for (const client of this.clients) client.stop()
    this.clients.clear()
  }
}
