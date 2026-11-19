import { randomUUID } from 'node:crypto'
import type { ConnectionTestResult, TranslateInput, TranslateResult } from '../shared/types'
import type { ConnectionConfig, WorkerRequest, WorkerResponse } from './protocol'
import type { Release } from './releases'

export interface WorkerTransport {
  postMessage: (message: WorkerRequest) => void
  kill: () => unknown
  on(event: 'message', listener: (message: WorkerResponse) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
}
export type WorkerFactory = () => WorkerTransport
interface Pending {
  resolve: (result: TranslateResult | ConnectionTestResult) => void
  delta: (text: string) => void
  cleanup: () => void
}
const failed = (message: string, cancelled = false): TranslateResult => ({ ok: false, error: { code: cancelled ? 'cancelled' : 'unknown', message }, cancelled })

export class WorkerClient {
  private pending = new Map<string, Pending>()
  private transport: WorkerTransport
  private dead = false
  private initialized = false
  private draining = false
  private drainTimer?: ReturnType<typeof setTimeout>
  private readyResolve!: () => void
  private readyReject!: (reason: Error) => void
  private readyTimer: ReturnType<typeof setTimeout>
  readonly ready: Promise<void>

  readonly release: Release
  private onExit: () => void
  private graceMs: number
  constructor(release: Release, factory: WorkerFactory, onExit: () => void, graceMs = 190000) {
    this.release = release
    this.onExit = onExit
    this.graceMs = graceMs
    this.transport = factory()
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
    this.readyTimer = setTimeout(() => { this.readyReject(new Error('翻译模块启动超时。')); this.stop() }, 10000)
    this.transport.on('message', (message: WorkerResponse) => this.receive(message))
    this.transport.on('exit', () => this.exited())
    try { this.transport.postMessage({ type: 'init', enginePath: release.enginePath, strategy: release.strategy }) }
    catch { this.readyReject(new Error('无法启动翻译进程。')); queueMicrotask(() => this.stop()) }
  }

  private receive(message: WorkerResponse): void {
    if (!message || this.dead) return
    if (message.type === 'ready') { this.initialized = true; clearTimeout(this.readyTimer); this.readyResolve(); return }
    if (message.type === 'fatal') { this.readyReject(new Error(message.message)); this.stop(); return }
    const pending = this.pending.get(message.id)
    if (!pending) return
    if (message.type === 'delta') {
      if (typeof message.delta === 'string') pending.delta(message.delta)
    } else if (message.type === 'result') this.finish(message.id, message.result)
  }

  private finish(id: string, result: TranslateResult | ConnectionTestResult): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.cleanup()
    pending.resolve(result)
    if (this.draining && !this.pending.size) this.stop()
  }

  private exited(): void {
    if (this.dead) return
    this.dead = true
    clearTimeout(this.readyTimer)
    clearTimeout(this.drainTimer)
    this.readyReject(new Error('翻译进程已退出。'))
    for (const id of this.pending.keys()) this.finish(id, failed('翻译进程已退出，请重试。'))
    this.onExit()
  }

  async request(type: 'translate' | 'test', config: ConnectionConfig, input?: TranslateInput,
    onDelta: (text: string) => void = () => {}, signal?: AbortSignal): Promise<TranslateResult | ConnectionTestResult> {
    if (!this.initialized) await this.ready
    if (this.dead || this.draining) return failed('翻译模块正在切换，请重试。')
    if (signal?.aborted) return failed('已取消翻译。', true)
    const id = randomUUID()
    return new Promise(resolve => {
      const abort = (): void => {
        try { this.transport.postMessage({ type: 'cancel', id }) } catch { /* process exited */ }
        this.finish(id, failed('已取消翻译。', true))
      }
      // Host deadline still applies if updated code ignores its AbortSignal.
      const timer = setTimeout(() => {
        this.finish(id, { ok: false, error: { code: 'timeout', message: '翻译进程响应超时，请重试。' } })
        this.stop()
      }, type === 'test' ? 35000 : this.release.strategy.translationTimeoutMs + 5000)
      this.pending.set(id, { resolve, delta: onDelta, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) } })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        this.transport.postMessage(type === 'test' ? { type, id, config } : { type, id, config, input: input! })
      } catch { this.finish(id, failed('无法连接翻译进程。')); this.stop() }
    })
  }

  retire(): void {
    this.draining = true
    if (!this.pending.size) this.stop()
    else this.drainTimer = setTimeout(() => this.stop(), this.graceMs)
  }

  stop(): void {
    if (this.dead) return
    this.exited()
    this.transport.kill()
  }
}
