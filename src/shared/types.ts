export type TranslationFont = 'serif' | 'sans' | 'kai'
export type ReaderTone = 'original' | 'sepia' | 'night'

export interface LibraryEntry {
  id: string
  title: string
  size: number
  pageCount: number
  lastPage: number
  addedAt: number
  openedAt: number
}

export interface ImportFailure {
  name: string
  error: string
}

export interface ImportResult {
  canceled: boolean
  imported: LibraryEntry[]
  duplicates: string[]
  existing?: LibraryEntry[]
  failed: ImportFailure[]
}

export interface TranslationPreferences {
  autoTranslate: boolean
  translationFont: TranslationFont
  translationFontSize: number
  translationLineHeight: number
  readerTone: ReaderTone
}

export interface PublicLlmConfig {
  baseUrl: string
  modelId: string
  targetLanguage: string
  apiKeyConfigured: boolean
  keyStorage: 'encrypted' | 'plaintext' | 'none'
}

export interface AppSettings {
  llm: PublicLlmConfig
  preferences: TranslationPreferences
}

export interface SaveSettingsInput {
  baseUrl?: string
  modelId?: string
  targetLanguage?: string
  apiKey?: string
  clearApiKey?: boolean
  preferences?: Partial<TranslationPreferences>
}

export interface SaveSettingsResult {
  ok: boolean
  settings?: AppSettings
  error?: string
}

export interface ConnectionTestInput {
  clearApiKey?: boolean
  baseUrl: string
  modelId: string
  apiKey?: string
}

export interface ConnectionTestResult {
  ok: boolean
  message: string
  latencyMs?: number
}

export interface TranslateInput {
  requestId: string
  text: string
  targetLanguage: string
  mode?: TranslationMode
  context?: SelectionContext
}

export type TranslationMode = 'translation' | 'lookup'

export interface SelectionContext {
  before: string
  after: string
}

export interface LookupEntry {
  lemma: string
  contextual: { partOfSpeech: string; meaning: string; explanation: string } | null
  common: Array<{ partOfSpeech: string; meanings: string[] }>
}

export type LookupResponse =
  | { kind: 'lookup'; entry: LookupEntry }
  | { kind: 'translation'; translation: string }

export interface TranslateError {
  message: string
  code:
    | 'not_configured'
    | 'auth'
    | 'rate_limit'
    | 'network'
    | 'timeout'
    | 'cancelled'
    | 'empty_response'
    | 'bad_request'
    | 'server'
    | 'unknown'
}

export type TranslationVote = 'up' | 'down'

export interface TranslateResult {
  feedbackId?: string
  ok: boolean
  text?: string
  error?: TranslateError
  cancelled?: boolean
  mode?: TranslationMode
  lookup?: LookupEntry
  runtimeVersion?: string
  runtimeId?: string
  strategyVersion?: string
}

export interface TranslationRuntimeStatus {
  id: string
  version: string
  strategyVersion: string
  builtin: boolean
  canRollback: boolean
  lastError?: string
}

export interface TranslationUpdateResult {
  ok: boolean
  canceled?: boolean
  status: TranslationRuntimeStatus
  error?: string
}

export interface TranslationDelta {
  requestId: string
  delta: string
}

export type AppCommand =
  | { type: 'import' }
  | { type: 'settings' }
  | { type: 'import-paths'; paths: string[] }

export interface ReadingTimeApi {
  library: {
    list: () => Promise<LibraryEntry[]>
    importDialog: () => Promise<ImportResult>
    importPaths: (paths: string[]) => Promise<ImportResult>
    read: (id: string) => Promise<Uint8Array>
    update: (
      id: string,
      patch: Partial<Pick<LibraryEntry, 'title' | 'lastPage' | 'pageCount'>>
    ) => Promise<LibraryEntry | null>
    remove: (id: string) => Promise<{ ok: boolean; error?: string }>
  }
  settings: {
    get: () => Promise<AppSettings>
    save: (input: SaveSettingsInput) => Promise<SaveSettingsResult>
    testConnection: (input: ConnectionTestInput) => Promise<ConnectionTestResult>
  }
  translate: {
    feedback: (id: string, vote: TranslationVote | null, reason?: string) => Promise<{ ok: boolean; error?: string }>
    start: (input: TranslateInput) => Promise<TranslateResult>
    cancel: (requestId: string) => Promise<void>
    onDelta: (callback: (payload: TranslationDelta) => void) => () => void
  }
  translationRuntime: {
    status: () => Promise<TranslationRuntimeStatus>
    importUpdate: () => Promise<TranslationUpdateResult>
    rollback: () => Promise<TranslationUpdateResult>
    restoreBuiltin: () => Promise<TranslationUpdateResult>
  }
  app: {
    ready: () => Promise<void>
    getVersion: () => Promise<string>
    copyText: (text: string) => Promise<void>
    getPathForFile: (file: File) => string
    onCommand: (callback: (command: AppCommand) => void) => () => void
  }
}

export const DEFAULT_PREFERENCES: TranslationPreferences = {
  autoTranslate: true,
  translationFont: 'serif',
  translationFontSize: 17,
  translationLineHeight: 1.8,
  readerTone: 'original'
}

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_TARGET_LANGUAGE = '简体中文'
export const MAX_SELECTION_LENGTH = 8000
export const MAX_TRANSLATION_INPUT = 12000
