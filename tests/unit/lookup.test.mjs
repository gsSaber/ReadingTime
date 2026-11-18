import test from 'node:test'
import assert from 'node:assert/strict'
import { contextAroundSelection, detectTranslationMode, formatLookup } from '../../src/shared/lookup.ts'

test('words and short lexical phrases are lookup candidates; passages and numbers remain translation', () => {
  for (const value of ['reading', 'take into account', 'well-being', "don't", 'U.S.', '人工智能', '目を通す']) {
    assert.equal(detectTranslationMode(value), 'lookup', value)
  }
  for (const value of ['', '12345', 'Reading is not a race.', 'This passage has far too many separate words for a vocabulary entry', 'one\ntwo']) {
    assert.equal(detectTranslationMode(value), 'translation', value)
  }
})

test('context uses selected offsets for repeated words and bounds the amount sent', () => {
  const text = 'A bank provides loans. We walked along the river bank and saw birds. The water was quiet. Far away a bank closed.'
  const start = text.indexOf('bank and')
  const context = contextAroundSelection(text, start, start + 4)
  assert.match(context.before, /river$/)
  assert.match(context.after, /^and saw birds/)
  assert.doesNotMatch(context.after, /bank closed/)
  const bounded = contextAroundSelection('a '.repeat(2000), 1500, 1504)
  assert.ok(bounded.before.length <= 400 && bounded.after.length <= 400)
})

test('copied vocabulary contains both contextual and common meanings in readable text', () => {
  const text = formatLookup({ lemma: 'bank', contextual: { partOfSpeech: '名词', meaning: '河岸', explanation: 'river 提供线索。' }, common: [{ partOfSpeech: '名词', meanings: ['银行', '河岸'] }] })
  assert.match(text, /此处用法\n名词 · 河岸/)
  assert.match(text, /常用释义\n名词 · 银行；河岸/)
  assert.match(formatLookup({ lemma: 'unknown', contextual: null, common: [] }), /语境不足/)
})
