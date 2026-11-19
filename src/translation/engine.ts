import { lookupText, translateText, testConnection } from './llm.ts'
import { detectTranslationMode, formatLookup } from '../shared/lookup.ts'
import type { TranslationEngine } from './protocol'

export const protocolVersion = 1 as const

export const translate: TranslationEngine['translate'] = async ({ input, config, strategy }, onDelta, signal) => {
  const context = input.context ? {
    before: strategy.maxContextSide ? input.context.before.slice(-strategy.maxContextSide) : '',
    after: input.context.after.slice(0, strategy.maxContextSide)
  } : undefined
  if ((input.mode ?? detectTranslationMode(input.text, strategy.routing)) === 'lookup') {
    const response = await lookupText(config, input.text, input.targetLanguage, context, signal, input.mode === 'lookup', strategy)
    if (response.kind === 'translation') return { ok: true, mode: 'translation', text: response.translation }
    return { ok: true, mode: 'lookup', lookup: response.entry, text: formatLookup(response.entry, input.text) }
  }
  const text = await translateText(config, input.text, input.targetLanguage, onDelta, signal, strategy)
  return { ok: true, mode: 'translation', text }
}

export { testConnection }
