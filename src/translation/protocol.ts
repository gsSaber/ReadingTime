import type { ConnectionTestResult, TranslateInput, TranslateResult } from '../shared/types'
import type { TranslationStrategy } from './strategy'

export interface ConnectionConfig { baseUrl: string; modelId: string; apiKey: string | null }
export interface EngineRequest { input: TranslateInput; config: ConnectionConfig; strategy: TranslationStrategy }
export interface TranslationEngine {
  protocolVersion: 1
  translate: (request: EngineRequest, onDelta: (delta: string) => void, signal: AbortSignal) => Promise<TranslateResult>
  testConnection: (config: ConnectionConfig) => Promise<ConnectionTestResult>
}
export type WorkerRequest =
  | { type: 'init'; enginePath: string; strategy: TranslationStrategy }
  | { type: 'translate'; id: string; input: TranslateInput; config: ConnectionConfig }
  | { type: 'test'; id: string; config: ConnectionConfig }
  | { type: 'cancel'; id: string }
export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'fatal'; message: string }
  | { type: 'delta'; id: string; delta: string }
  | { type: 'result'; id: string; result: TranslateResult | ConnectionTestResult }
