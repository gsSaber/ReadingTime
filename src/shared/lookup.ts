import type { LookupEntry, SelectionContext, TranslationMode } from './types'

export const MAX_CONTEXT_SIDE = 400

export function detectTranslationMode(text: string, limits = {
  maxLookupCharacters: 80, maxLookupWords: 8, maxCjkCharacters: 16
}): TranslationMode {
  const value = text.trim()
  if (!value || value.length > limits.maxLookupCharacters) return 'translation'
  if (/^(?:\p{L}\.){2,}$/u.test(value)) return 'lookup'
  if (/[.!?。！？;；\n]/u.test(value)) return 'translation'
  if (!/\p{L}/u.test(value)) return 'translation'
  // Short unspaced CJK selections are vocabulary candidates as well.
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value)) {
    return value.replace(/\s/g, '').length <= limits.maxCjkCharacters ? 'lookup' : 'translation'
  }
  return value.split(/\s+/u).length <= limits.maxLookupWords ? 'lookup' : 'translation'
}

export function contextAroundSelection(text: string, start: number, end: number): SelectionContext {
  const clean = (value: string): string => value.replace(/-\s*\n\s*(?=[a-z])/gi, '').replace(/\s+/g, ' ').trim()
  let before = text.slice(Math.max(0, start - MAX_CONTEXT_SIDE), start)
  let after = text.slice(end, end + MAX_CONTEXT_SIDE)
  const paragraphStart = before.lastIndexOf('\n\n')
  if (paragraphStart >= 0) before = before.slice(paragraphStart + 2)
  const paragraphEnd = after.indexOf('\n\n')
  if (paragraphEnd >= 0) after = after.slice(0, paragraphEnd)
  // Keep the containing sentence and at most a neighboring sentence, rather than whole pages.
  const leftBoundaries = [...before.matchAll(/[.!?。！？](?:\s|$)/gu)]
  if (leftBoundaries.length > 1) before = before.slice(leftBoundaries.at(-2)!.index! + 1)
  const rightBoundaries = [...after.matchAll(/[.!?。！？](?:\s|$)/gu)]
  if (rightBoundaries.length > 1) after = after.slice(0, rightBoundaries[1].index! + 1)
  return { before: clean(before), after: clean(after) }
}

export function formatLookup(entry: LookupEntry, selection = entry.lemma): string {
  const contextual = entry.contextual
    ? `${entry.contextual.partOfSpeech} · ${entry.contextual.meaning}\n${entry.contextual.explanation}`
    : '语境不足，暂不能确定此处的词性和含义。'
  const title = selection.toLocaleLowerCase() === entry.lemma.toLocaleLowerCase()
    ? selection : `${selection}（原形：${entry.lemma}）`
  return [title, `此处用法\n${contextual}`, `常用释义\n${entry.common.map(
    (sense) => `${sense.partOfSpeech} · ${sense.meanings.join('；')}`
  ).join('\n') || '暂无可靠的常用释义。'}`].join('\n\n')
}
