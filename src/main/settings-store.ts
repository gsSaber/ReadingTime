import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import {
  DEFAULT_BASE_URL,
  DEFAULT_PREFERENCES,
  DEFAULT_TARGET_LANGUAGE,
  type AppSettings,
  type PublicLlmConfig,
  type ReaderTone,
  type SaveSettingsInput,
  type TranslationFont,
  type TranslationPreferences
} from '../shared/types'

interface StoredLlmConfig {
  baseUrl: string
  modelId: string
  targetLanguage: string
  apiKey?: string
  apiKeyEncoding?: 'safe' | 'base64'
}

interface StoredSettings {
  version: 1
  llm: StoredLlmConfig
  preferences: TranslationPreferences
}

const FONT_VALUES: TranslationFont[] = ['serif', 'sans', 'kai']
const TONE_VALUES: ReaderTone[] = ['original', 'sepia', 'night']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  return value.trim().slice(0, maxLength)
}

function defaultStoredSettings(): StoredSettings {
  return {
    version: 1,
    llm: {
      baseUrl: DEFAULT_BASE_URL,
      modelId: '',
      targetLanguage: DEFAULT_TARGET_LANGUAGE
    },
    preferences: { ...DEFAULT_PREFERENCES }
  }
}

export class SettingsStore {
  private readonly filePath: string
  private data: StoredSettings

  constructor(userDataPath: string) {
    const dataDir = join(userDataPath, 'data')
    mkdirSync(dataDir, { recursive: true })
    this.filePath = join(dataDir, 'settings.json')
    this.data = this.load()
  }

  private load(): StoredSettings {
    if (!existsSync(this.filePath)) return defaultStoredSettings()
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (!isRecord(parsed)) return defaultStoredSettings()
      const defaults = defaultStoredSettings()
      const llm = isRecord(parsed.llm) ? parsed.llm : {}
      const prefs = isRecord(parsed.preferences) ? parsed.preferences : {}
      return {
        version: 1,
        llm: {
          baseUrl:
            typeof llm.baseUrl === 'string' && llm.baseUrl.trim()
              ? llm.baseUrl.trim()
              : defaults.llm.baseUrl,
          modelId: typeof llm.modelId === 'string' ? llm.modelId.trim() : '',
          targetLanguage:
            typeof llm.targetLanguage === 'string' && llm.targetLanguage.trim()
              ? llm.targetLanguage.trim()
              : DEFAULT_TARGET_LANGUAGE,
          apiKey: typeof llm.apiKey === 'string' ? llm.apiKey : undefined,
          apiKeyEncoding:
            llm.apiKeyEncoding === 'safe' || llm.apiKeyEncoding === 'base64'
              ? llm.apiKeyEncoding
              : undefined
        },
        preferences: this.normalizePreferences(prefs, defaults.preferences)
      }
    } catch (error) {
      console.error('[settings] Failed to load settings, starting fresh.', error)
      return defaultStoredSettings()
    }
  }

  private normalizePreferences(
    input: Record<string, unknown>,
    fallback: TranslationPreferences = DEFAULT_PREFERENCES
  ): TranslationPreferences {
    return {
      autoTranslate:
        typeof input.autoTranslate === 'boolean'
          ? input.autoTranslate
          : fallback.autoTranslate,
      translationFont:
        typeof input.translationFont === 'string' &&
        FONT_VALUES.includes(input.translationFont as TranslationFont)
          ? (input.translationFont as TranslationFont)
          : fallback.translationFont,
      translationFontSize:
        typeof input.translationFontSize === 'number' &&
        Number.isFinite(input.translationFontSize)
          ? clamp(Math.round(input.translationFontSize), 13, 30)
          : fallback.translationFontSize,
      translationLineHeight:
        typeof input.translationLineHeight === 'number' &&
        Number.isFinite(input.translationLineHeight)
          ? clamp(Math.round(input.translationLineHeight * 10) / 10, 1.3, 2.4)
          : fallback.translationLineHeight,
      readerTone:
        typeof input.readerTone === 'string' &&
        TONE_VALUES.includes(input.readerTone as ReaderTone)
          ? (input.readerTone as ReaderTone)
          : fallback.readerTone
    }
  }

  private persist(): void {
    const temporaryPath = `${this.filePath}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(this.data, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    })
    renameSync(temporaryPath, this.filePath)
  }

  private encryptApiKey(apiKey: string): Pick<StoredLlmConfig, 'apiKey' | 'apiKeyEncoding'> {
    if (safeStorage.isEncryptionAvailable()) {
      return {
        apiKey: safeStorage.encryptString(apiKey).toString('base64'),
        apiKeyEncoding: 'safe'
      }
    }
    // Some Linux setups have no keyring. Keeping the key local is more useful
    // than disabling translation, and the UI clearly labels this fallback.
    return {
      apiKey: Buffer.from(apiKey, 'utf8').toString('base64'),
      apiKeyEncoding: 'base64'
    }
  }

  getApiKey(): string | null {
    const { apiKey, apiKeyEncoding } = this.data.llm
    if (!apiKey || !apiKeyEncoding) return null
    try {
      if (apiKeyEncoding === 'safe') {
        if (!safeStorage.isEncryptionAvailable()) return null
        return safeStorage.decryptString(Buffer.from(apiKey, 'base64'))
      }
      return Buffer.from(apiKey, 'base64').toString('utf8')
    } catch (error) {
      console.error('[settings] Failed to decrypt API key.', error)
      return null
    }
  }

  private toPublicConfig(): PublicLlmConfig {
    const hasKey = Boolean(this.getApiKey())
    return {
      baseUrl: this.data.llm.baseUrl,
      modelId: this.data.llm.modelId,
      targetLanguage: this.data.llm.targetLanguage,
      apiKeyConfigured: hasKey,
      keyStorage: hasKey
        ? this.data.llm.apiKeyEncoding === 'safe'
          ? 'encrypted'
          : 'plaintext'
        : 'none'
    }
  }

  get(): AppSettings {
    return {
      llm: this.toPublicConfig(),
      preferences: { ...this.data.preferences }
    }
  }

  save(input: SaveSettingsInput): { ok: boolean; settings?: AppSettings; error?: string } {
    if (typeof input !== 'object' || input === null) {
      return { ok: false, error: '无效的设置内容。' }
    }

    if (typeof input.baseUrl === 'string') {
      const baseUrl = input.baseUrl.trim().slice(0, 500)
      if (baseUrl) {
        try {
          const parsed = new URL(baseUrl)
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { ok: false, error: 'Base URL 必须使用 http:// 或 https://。' }
          }
        } catch {
          return { ok: false, error: 'Base URL 格式不正确，请填入完整地址。' }
        }
        this.data.llm.baseUrl = baseUrl.replace(/\/+$/, '')
      } else {
        this.data.llm.baseUrl = ''
      }
    }

    if (typeof input.modelId === 'string') {
      this.data.llm.modelId = input.modelId.trim().slice(0, 200)
    }

    if (typeof input.targetLanguage === 'string') {
      this.data.llm.targetLanguage =
        input.targetLanguage.trim().slice(0, 50) || DEFAULT_TARGET_LANGUAGE
    }

    if (input.clearApiKey) {
      delete this.data.llm.apiKey
      delete this.data.llm.apiKeyEncoding
    } else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
      Object.assign(this.data.llm, this.encryptApiKey(input.apiKey.trim()))
    }

    if (isRecord(input.preferences)) {
      this.data.preferences = this.normalizePreferences(
        { ...this.data.preferences, ...input.preferences },
        this.data.preferences
      )
    }

    try {
      this.persist()
      return { ok: true, settings: this.get() }
    } catch (error) {
      console.error('[settings] Failed to persist settings.', error)
      return { ok: false, error: '设置保存失败，请检查应用的存储权限。' }
    }
  }

  getConnectionInput(overrides: {
    baseUrl: string
    modelId: string
    apiKey?: string
  }): { baseUrl: string; modelId: string; apiKey: string | null } {
    return {
      baseUrl: cleanString(overrides.baseUrl, 500) || this.data.llm.baseUrl,
      modelId: cleanString(overrides.modelId, 200) || this.data.llm.modelId,
      apiKey: cleanString(overrides.apiKey, 1000) || this.getApiKey()
    }
  }
}
