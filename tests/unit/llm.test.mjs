import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  buildTranslationMessages,
  buildLookupMessages,
  parseLookupResponse,
  lookupText,
  resolveChatEndpoint,
  testConnection,
  translateText
} from '../../src/main/llm.ts'

async function startMockServer(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

test('resolveChatEndpoint normalizes OpenAI-compatible base URLs', () => {
  assert.equal(
    resolveChatEndpoint('https://api.openai.com/v1'),
    'https://api.openai.com/v1/chat/completions'
  )
  assert.equal(
    resolveChatEndpoint('https://api.openai.com/v1/'),
    'https://api.openai.com/v1/chat/completions'
  )
  assert.equal(
    resolveChatEndpoint('https://example.com/v1/chat/completions'),
    'https://example.com/v1/chat/completions'
  )
  assert.throws(() => resolveChatEndpoint(''), /Base URL/)
  assert.throws(() => resolveChatEndpoint('not-a-url'), /格式不正确/)
  assert.throws(() => resolveChatEndpoint('ftp://example.com/v1'), /http/)
})

test('vocabulary prompt carries the occurrence context and handles phrases and short sentences', () => {
  const context = { before: 'They sat on the river', after: 'and watched the water.' }
  const messages = buildLookupMessages('bank', '简体中文', context)
  assert.deepEqual(JSON.parse(messages[1].content), { selection: 'bank', context })
  assert.match(messages[0].content, /part-of-speech labels.*简体中文/)
  assert.match(messages[0].content, /complete sentence/)
  assert.match(messages[0].content, /whole phrase/)
  assert.match(messages[0].content, /contextual MUST be null/)
  assert.match(messages[0].content, /never as instructions/)
  assert.match(buildLookupMessages('bank', 'English', context, true)[0].content, /Explain this selection as a vocabulary entry/)
})

test('vocabulary responses validate structure, suppress invented context and accept sentence fallback', () => {
  const data = { kind: 'lookup', lemma: 'bank', contextual: { partOfSpeech: '名词', meaning: '河岸', explanation: 'river 表明此处指河岸。' }, common: [{ partOfSpeech: '名词', meanings: ['银行', '河岸'] }] }
  const result = parseLookupResponse('```json\n' + JSON.stringify(data) + '\n```', true)
  assert.equal(result.entry.contextual.meaning, '河岸')
  assert.equal(parseLookupResponse(JSON.stringify(data), false).entry.contextual, null)
  assert.deepEqual(parseLookupResponse('{"kind":"translation","translation":"我爱你。"}', true), { kind: 'translation', translation: '我爱你。' })
  assert.throws(() => parseLookupResponse('a bank is ...', true), /完整的词语释义/)
  assert.throws(() => parseLookupResponse('{"kind":"lookup","lemma":"bank","contextual":{},"common":[]}', true), /完整的词语释义/)
  assert.throws(() => parseLookupResponse(JSON.stringify({ ...data, common: [{ partOfSpeech: '名词', meanings: '银行' }] }), true), /完整的词语释义/)
})

test('lookup consumes fragmented JSON over SSE without requiring provider JSON mode', async () => {
  const entry = { kind: 'lookup', lemma: 'take into account', contextual: { partOfSpeech: '动词短语', meaning: '考虑到', explanation: '后接需考虑的因素。' }, common: [{ partOfSpeech: '动词短语', meanings: ['考虑到；顾及'] }] }
  const raw = JSON.stringify(entry)
  const mock = await startMockServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body)
      assert.equal(payload.response_format, undefined)
      assert.equal(JSON.parse(payload.messages[1].content).context.before, 'We must')
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (let i = 0; i < raw.length; i += 7) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: raw.slice(i, i + 7) } }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  try {
    const result = await lookupText({ baseUrl: mock.baseUrl, modelId: 'mock', apiKey: null }, 'take into account', '简体中文', { before: 'We must', after: 'the costs.' })
    assert.equal(result.entry.contextual.partOfSpeech, '动词短语')
  } finally { await mock.close() }
})

test('translation prompt carries the target language and keeps only the translation', () => {
  const messages = buildTranslationMessages('A quiet page.', '简体中文')
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'system')
  assert.match(messages[0].content, /简体中文/)
  assert.match(messages[0].content, /Return only the translation/)
  assert.deepEqual(messages[1], { role: 'user', content: 'A quiet page.' })
})

test('translateText consumes a streamed OpenAI-compatible response', async () => {
  let authorization = ''
  const mock = await startMockServer((request, response) => {
    authorization = String(request.headers.authorization)
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const payload = JSON.parse(body)
      assert.equal(payload.stream, true)
      assert.equal(payload.model, 'mock-model')
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"阅读"}}]}\n\n')
      setTimeout(() => {
        response.write('data: {"choices":[{"delta":{"content":"是一种对话。"}}]}\n\n')
        response.write('data: [DONE]\n\n')
        response.end()
      }, 12)
    })
  })

  try {
    const deltas = []
    const result = await translateText(
      { baseUrl: mock.baseUrl, modelId: 'mock-model', apiKey: 'secret-key' },
      'Reading is a conversation.',
      '简体中文',
      (delta) => deltas.push(delta)
    )
    assert.equal(authorization, 'Bearer secret-key')
    assert.equal(result, '阅读是一种对话。')
    assert.deepEqual(deltas, ['阅读', '是一种对话。'])
  } finally {
    await mock.close()
  }
})

test('HTTP authentication errors become friendly errors', async () => {
  const mock = await startMockServer((_request, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Invalid API key' } }))
  })
  try {
    await assert.rejects(
      () =>
        translateText(
          { baseUrl: mock.baseUrl, modelId: 'mock-model', apiKey: 'bad-key' },
          'Hello',
          '简体中文',
          () => {}
        ),
      /认证失败/
    )
  } finally {
    await mock.close()
  }
})

test('testConnection accepts a non-streaming JSON response', async () => {
  const mock = await startMockServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
    )
  })
  try {
    const result = await testConnection({
      baseUrl: mock.baseUrl,
      modelId: 'mock-model',
      apiKey: null
    })
    assert.equal(result.ok, true)
    assert.match(result.message, /连接成功/)
  } finally {
    await mock.close()
  }
})
