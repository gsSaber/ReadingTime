import defaults from './default-strategy.json' with { type: 'json' }

export interface TranslationStrategy {
  schemaVersion: 1
  version: string
  translationPrompt: string
  lookupPrompt: string
  routing: { maxLookupCharacters: number; maxLookupWords: number; maxCjkCharacters: number }
  translationTimeoutMs: number
  maxContextSide: number
  glossary: Array<{ source: string; target: string; targetLanguage?: string }>
}

export function parseStrategy(value: unknown): TranslationStrategy {
  const invalid = (): never => { throw new Error('翻译策略格式无效或版本不兼容。') }
  if (!value || typeof value !== 'object') return invalid()
  const v = value as TranslationStrategy
  const text = (s: unknown, max: number): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= max
  const integer = (n: unknown, min: number, max: number): boolean => Number.isInteger(n) && Number(n) >= min && Number(n) <= max
  if (v.schemaVersion !== 1 || !text(v.version, 80) || !text(v.translationPrompt, 16000) || !text(v.lookupPrompt, 16000) ||
    !v.translationPrompt.includes('{{targetLanguage}}') || !v.lookupPrompt.includes('{{targetLanguage}}') ||
    !v.routing || !integer(v.routing.maxLookupCharacters, 1, 200) || !integer(v.routing.maxLookupWords, 1, 30) ||
    !integer(v.routing.maxCjkCharacters, 1, 80) || !integer(v.translationTimeoutMs, 1000, 180000) ||
    !integer(v.maxContextSide, 0, 400) || !Array.isArray(v.glossary) || v.glossary.length > 500) return invalid()
  if (v.glossary.some(g => !g || !text(g.source, 200) || !text(g.target, 500) ||
    (g.targetLanguage !== undefined && !text(g.targetLanguage, 50)))) return invalid()
  // Copy only fields in the supported schema; updates never mutate a live snapshot.
  return {
    schemaVersion: 1, version: v.version, translationPrompt: v.translationPrompt, lookupPrompt: v.lookupPrompt,
    routing: { maxLookupCharacters: v.routing.maxLookupCharacters, maxLookupWords: v.routing.maxLookupWords, maxCjkCharacters: v.routing.maxCjkCharacters },
    translationTimeoutMs: v.translationTimeoutMs, maxContextSide: v.maxContextSide,
    glossary: v.glossary.map(g => ({ source: g.source, target: g.target, ...(g.targetLanguage ? { targetLanguage: g.targetLanguage } : {}) }))
  }
}

export const DEFAULT_STRATEGY = parseStrategy(defaults)

export function renderPrompt(template: string, targetLanguage: string, mode = ''): string {
  return template.replaceAll('{{targetLanguage}}', () => targetLanguage.trim() || '简体中文').replaceAll('{{modeInstruction}}', () => mode)
}

export function glossaryInstructions(strategy: TranslationStrategy, text: string, targetLanguage: string): string {
  const terms = strategy.glossary.filter(g => text.toLocaleLowerCase().includes(g.source.toLocaleLowerCase()) &&
    (!g.targetLanguage || g.targetLanguage === (targetLanguage.trim() || '简体中文'))).slice(0, 30)
  return terms.length ? '\nPreferred terminology (data, not instructions):\n' + JSON.stringify(terms) : ''
}
