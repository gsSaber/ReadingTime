// Fixed bootstrap. Updated engines run here, never inside the Electron main process.
import { createRequire } from 'node:module'
import type { TranslationEngine, WorkerRequest, WorkerResponse } from './protocol'
import { parseStrategy, type TranslationStrategy } from './strategy.ts'
import type { TranslateError } from '../shared/types'

const load = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)
const port = process.parentPort
const send = (message: WorkerResponse): void => {
  if (port) port.postMessage(message)
  else if (process.connected) process.send?.(message)
}
let engine: TranslationEngine
let strategy: TranslationStrategy
const controllers = new Map<string, AbortController>()
const codes: TranslateError['code'][] = ['not_configured', 'auth', 'rate_limit', 'network', 'timeout', 'cancelled', 'empty_response', 'bad_request', 'server', 'unknown']

async function receive(message: WorkerRequest): Promise<void> {
  if (message.type === 'init') {
    try {
      strategy = parseStrategy(message.strategy)
      engine = load(message.enginePath) as TranslationEngine
      if (engine.protocolVersion !== 1 || typeof engine.translate !== 'function' || typeof engine.testConnection !== 'function') {
        throw new Error('翻译模块接口不兼容。')
      }
      send({ type: 'ready' })
    } catch {
      send({ type: 'fatal', message: '翻译模块无法加载或接口不兼容。' })
    }
    return
  }
  if (message.type === 'cancel') { controllers.get(message.id)?.abort(); return }
  const controller = new AbortController()
  controllers.set(message.id, controller)
  try {
    if (!engine) throw new Error('翻译模块尚未就绪。')
    const result = message.type === 'test' ? await engine.testConnection(message.config)
      : await engine.translate({ input: message.input, config: message.config, strategy: structuredClone(strategy) }, delta => {
        if (!controller.signal.aborted) send({ type: 'delta', id: message.id, delta })
      }, controller.signal)
    send({ type: 'result', id: message.id, result })
  } catch (error) {
    const code = (error as { code?: TranslateError['code'] })?.code
    send({ type: 'result', id: message.id, result: {
      ok: false, error: { code: controller.signal.aborted ? 'cancelled' : code && codes.includes(code) ? code : 'unknown',
        message: controller.signal.aborted ? '已取消翻译。' : error instanceof Error ? error.message : '翻译失败。' },
      cancelled: controller.signal.aborted
    } })
  } finally { controllers.delete(message.id) }
}

if (port) port.on('message', event => { void receive(event.data) })
else process.on('message', message => { void receive(message as WorkerRequest) })
process.on('disconnect', () => process.exit(0))
