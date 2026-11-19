import type { ConnectionTestResult, LookupEntry, LookupResponse, SelectionContext } from '../shared/types'

export { LlmRequestError } from './errors.ts'
import { LlmRequestError } from './errors.ts'
import { DEFAULT_STRATEGY, renderPrompt, glossaryInstructions, type TranslationStrategy } from './strategy.ts'

export interface LlmConnectionConfig {
  baseUrl: string
  modelId: string
  apiKey: string | null
}

interface ChatCallOptions extends LlmConnectionConfig {
  messages: Array<{ role: 'system' | 'user'; content: string }>
  stream: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

interface AbortState {
  controller: AbortController
  timedOut: boolean
  externallyAborted: boolean
  cleanup: () => void
}

const TRANSLATION_TIMEOUT_MS = 180_000
const TEST_TIMEOUT_MS = 30_000
const MAX_DETAIL_LENGTH = 240

export function resolveChatEndpoint(baseUrl: string): string {
  const value = baseUrl.trim()
  if (!value) {
    throw new LlmRequestError('还没有填写 Base URL，请先打开设置配置模型服务。', 'not_configured')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new LlmRequestError('Base URL 格式不正确，请填入完整地址。', 'bad_request')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new LlmRequestError('Base URL 必须使用 http:// 或 https://。', 'bad_request')
  }
  const trimmed = value.replace(/\/+$/, '')
  return /\/chat\/completions$/i.test(trimmed) ? trimmed : `${trimmed}/chat/completions`
}

export function buildTranslationMessages(
  text: string, targetLanguage: string, strategy: TranslationStrategy = DEFAULT_STRATEGY
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: renderPrompt(strategy.translationPrompt, targetLanguage) + glossaryInstructions(strategy, text, targetLanguage) },
    { role: 'user', content: text }
  ]
}

export function buildLookupMessages(
  text: string, targetLanguage: string, context?: SelectionContext, forceLookup = false,
  strategy: TranslationStrategy = DEFAULT_STRATEGY
): Array<{ role: 'system' | 'user'; content: string }> {
  const mode = forceLookup ? 'Explain this selection as a vocabulary entry.'
    : 'Determine whether the selection is a word/lexical phrase or a complete sentence. A complete sentence (even a short one, e.g. "I love you") must use the translation result below.'
  return [
    { role: 'system', content: renderPrompt(strategy.lookupPrompt, targetLanguage, mode) + glossaryInstructions(strategy, text, targetLanguage) },
    { role: 'user', content: JSON.stringify({ selection: text, context: context ?? null }) }
  ]
}

export function parseLookupResponse(raw: string, hasContext: boolean): LookupResponse {
  const invalid = (): never => { throw new LlmRequestError('模型未返回完整的词语释义，请重试，或切换为原文翻译。', 'empty_response') }
  let value: unknown
  try {
    value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
  } catch { return invalid() }
  const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  const field = (v: unknown, limit = 240): string => typeof v === 'string' ? v.trim().slice(0, limit) : ''
  if (!record(value)) return invalid()
  if (value.kind === 'translation') {
    const translation = field(value.translation, 12_000)
    return translation ? { kind: 'translation', translation } : invalid()
  }
  if (value.kind !== 'lookup' || !field(value.lemma, 100) || !Array.isArray(value.common)) return invalid()
  const common: LookupEntry['common'] = []
  for (const sense of value.common.slice(0, 4)) {
    if (!record(sense) || !field(sense.partOfSpeech, 50) || !Array.isArray(sense.meanings)) return invalid()
    const meanings = sense.meanings.slice(0, 3).map((meaning) => field(meaning)).filter(Boolean)
    if (!meanings.length) return invalid()
    common.push({ partOfSpeech: field(sense.partOfSpeech, 50), meanings })
  }
  let contextual: LookupEntry['contextual'] = null
  if (hasContext && value.contextual !== null) {
    if (!record(value.contextual) || !field(value.contextual.partOfSpeech, 50) || !field(value.contextual.meaning)) return invalid()
    contextual = {
      partOfSpeech: field(value.contextual.partOfSpeech, 50), meaning: field(value.contextual.meaning),
      explanation: field(value.contextual.explanation)
    }
  }
  return { kind: 'lookup', entry: { lemma: field(value.lemma, 100), contextual, common } }
}

export async function lookupText(
  config: LlmConnectionConfig, text: string, targetLanguage: string,
  context?: SelectionContext, signal?: AbortSignal, forceLookup = false,
  strategy: TranslationStrategy = DEFAULT_STRATEGY
): Promise<LookupResponse> {
  const raw = await performChat({
    ...config, messages: buildLookupMessages(text, targetLanguage, context, forceLookup, strategy), stream: true, signal, timeoutMs: strategy.translationTimeoutMs
  }, (response) => consumeStream(response, () => {}))
  return parseLookupResponse(raw, Boolean(context?.before || context?.after))
}

function createAbortState(signal: AbortSignal | undefined, timeoutMs: number): AbortState {
  const controller = new AbortController()
  const state: AbortState = {
    controller,
    timedOut: false,
    externallyAborted: false,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  const onAbort = (): void => {
    state.externallyAborted = true
    controller.abort()
  }
  const timer = setTimeout(() => {
    state.timedOut = true
    controller.abort()
  }, timeoutMs)

  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort)
  }
  return state
}

function normalizeRequestError(error: unknown, state: AbortState): LlmRequestError {
  if (error instanceof LlmRequestError) return error
  if (state.timedOut) {
    return new LlmRequestError('模型响应超时，请稍后重试或检查网络。', 'timeout')
  }
  if (state.externallyAborted) {
    return new LlmRequestError('已取消翻译。', 'cancelled')
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new LlmRequestError('请求已中断，请重试。', 'timeout')
  }
  if (error instanceof TypeError) {
    return new LlmRequestError(
      '无法连接到模型服务，请检查 Base URL、网络或本地服务是否已启动。',
      'network'
    )
  }
  return new LlmRequestError(
    error instanceof Error && error.message ? error.message : '翻译请求失败，请稍后重试。',
    'unknown'
  )
}

function truncateDetail(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_LENGTH)
}

async function describeHttpError(response: Response): Promise<LlmRequestError> {
  let detail = ''
  try {
    const raw = await response.text()
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as {
          error?: { message?: string } | string
          message?: string
        }
        detail =
          typeof parsed.error === 'string'
            ? parsed.error
            : parsed.error?.message || parsed.message || raw
      } catch {
        detail = raw
      }
    }
  } catch {
    // The status code still gives us a useful error.
  }
  detail = truncateDetail(detail)

  const status = response.status
  if (status === 401) {
    return new LlmRequestError('认证失败，请检查 API Key 是否正确。', 'auth')
  }
  if (status === 403) {
    return new LlmRequestError('服务拒绝了请求，请检查 API Key 权限或模型访问权限。', 'auth')
  }
  if (status === 404) {
    return new LlmRequestError(
      '接口地址不存在，请检查 Base URL（OpenAI 兼容地址通常以 /v1 结尾）。',
      'bad_request'
    )
  }
  if (status === 429) {
    return new LlmRequestError('请求过于频繁或账户额度不足，请稍后再试。', 'rate_limit')
  }
  if (status === 400 || status === 422) {
    return new LlmRequestError(
      `请求参数被模型服务拒绝${detail ? `：${detail}` : '，请检查模型 ID。'}`,
      'bad_request'
    )
  }
  if (status >= 500) {
    return new LlmRequestError(
      `模型服务暂时不可用（HTTP ${status}）。请稍后重试。`,
      'server'
    )
  }
  return new LlmRequestError(
    `模型服务返回错误（HTTP ${status}）${detail ? `：${detail}` : '。'}`,
    'unknown'
  )
}

function extractContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      if (typeof part === 'string') return part
      if (typeof part === 'object' && part !== null) {
        const item = part as { text?: unknown; content?: unknown }
        if (typeof item.text === 'string') return item.text
        if (typeof item.content === 'string') return item.content
      }
      return ''
    })
    .join('')
}

function extractDeltaFromPayload(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return ''
  const data = payload as {
    choices?: Array<{
      delta?: { content?: unknown }
      message?: { content?: unknown }
      text?: unknown
    }>
    error?: { message?: string } | string
  }
  if (data.error) {
    const message =
      typeof data.error === 'string' ? data.error : data.error.message || '模型服务返回错误。'
    throw new LlmRequestError(truncateDetail(message), 'server')
  }
  const choice = data.choices?.[0]
  if (!choice) return ''
  return extractContent(choice.delta?.content) || extractContent(choice.message?.content) || extractContent(choice.text)
}

async function consumeStream(
  response: Response,
  onDelta: (delta: string) => void
): Promise<string> {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('text/event-stream')) {
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new LlmRequestError('模型返回了无法解析的内容，请检查接口是否兼容 OpenAI Chat Completions。', 'empty_response')
    }
    const content = extractDeltaFromPayload(payload)
    if (!content) {
      throw new LlmRequestError('模型返回了空内容，请重试或更换模型。', 'empty_response')
    }
    onDelta(content)
    return content
  }

  if (!response.body) {
    throw new LlmRequestError('模型没有返回可读取的内容。', 'empty_response')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let total = ''
  let eventLines: string[] = []
  let finished = false

  const flushEvent = (): void => {
    if (!eventLines.length) return
    const data = eventLines.join('\n').trim()
    eventLines = []
    if (!data) return
    if (data === '[DONE]') {
      finished = true
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      // Ignore keep-alive or provider-specific non-JSON events.
      return
    }
    const delta = extractDeltaFromPayload(payload)
    if (delta) {
      total += delta
      onDelta(delta)
    }
  }

  const processLines = (text: string): void => {
    buffer += text
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line === '') {
        flushEvent()
        if (finished) return
      } else if (line.startsWith('data:')) {
        eventLines.push(line.slice(5).replace(/^ /, ''))
      }
    }
  }

  try {
    while (!finished) {
      const { done, value } = await reader.read()
      if (done) break
      processLines(decoder.decode(value, { stream: true }))
    }
    if (!finished) {
      processLines(decoder.decode())
      if (buffer.startsWith('data:')) {
        eventLines.push(buffer.slice(5).replace(/^ /, ''))
      }
      buffer = ''
      flushEvent()
    }
  } finally {
    reader.releaseLock()
  }

  if (!total.trim()) {
    throw new LlmRequestError('模型返回了空内容，请重试或更换模型。', 'empty_response')
  }
  return total
}

interface RequestRunner<T> {
  (response: Response): Promise<T>
}

async function performChat<T>(
  options: ChatCallOptions,
  runner: RequestRunner<T>
): Promise<T> {
  if (!options.modelId.trim()) {
    throw new LlmRequestError('还没有填写模型 ID，请先打开设置配置模型。', 'not_configured')
  }
  const endpoint = resolveChatEndpoint(options.baseUrl)
  const abortState = createAbortState(options.signal, options.timeoutMs ?? TRANSLATION_TIMEOUT_MS)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: options.stream ? 'text/event-stream' : 'application/json'
  }
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: options.modelId,
        messages: options.messages,
        stream: options.stream
      }),
      signal: abortState.controller.signal
    })
    if (!response.ok) throw await describeHttpError(response)
    return await runner(response)
  } catch (error) {
    throw normalizeRequestError(error, abortState)
  } finally {
    abortState.cleanup()
  }
}

export async function translateText(
  config: LlmConnectionConfig,
  text: string,
  targetLanguage: string,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
  strategy: TranslationStrategy = DEFAULT_STRATEGY
): Promise<string> {
  return performChat(
    {
      ...config,
      messages: buildTranslationMessages(text, targetLanguage, strategy),
      timeoutMs: strategy.translationTimeoutMs,
      stream: true,
      signal
    },
    (response) => consumeStream(response, onDelta)
  )
}

export async function testConnection(
  config: LlmConnectionConfig,
  signal?: AbortSignal
): Promise<ConnectionTestResult> {
  const startedAt = Date.now()
  try {
    await performChat(
      {
        ...config,
        messages: [
          {
            role: 'system',
            content: 'You are a connectivity test. Reply with exactly one short word: OK.'
          },
          { role: 'user', content: 'ping' }
        ],
        stream: false,
        signal,
        timeoutMs: TEST_TIMEOUT_MS
      },
      async (response) => {
        let data: unknown
        try {
          data = await response.json()
        } catch {
          throw new LlmRequestError(
            '服务有响应，但返回内容不是有效的 OpenAI 兼容 JSON。',
            'empty_response'
          )
        }
        const content = extractDeltaFromPayload(data)
        if (!content.trim()) {
          throw new LlmRequestError('服务已连接，但模型没有返回内容。', 'empty_response')
        }
        return content
      }
    )
    return {
      ok: true,
      message: `连接成功 · ${Date.now() - startedAt} ms`,
      latencyMs: Date.now() - startedAt
    }
  } catch (error) {
    const normalized =
      error instanceof LlmRequestError
        ? error
        : new LlmRequestError(
            error instanceof Error ? error.message : '连接测试失败。',
            'unknown'
          )
    return { ok: false, message: normalized.message }
  }
}
