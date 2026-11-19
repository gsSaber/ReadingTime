import { createServer } from 'node:http'
import type { TranslateResult } from '../shared/types'
import type { WorkerClient } from './client'

// Host-owned compatibility checks, with no user data, API keys or paid model calls.
// These verify the execution contract, not translation quality.
export async function validateCandidate(client: WorkerClient): Promise<void> {
  const entry = { kind: 'lookup', lemma: 'bank', contextual: null, common: [{ partOfSpeech: '名词', meanings: ['银行'] }] }
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      try {
        const payload = JSON.parse(body)
        if (payload.model === 'reject-auth') { response.writeHead(401); response.end('{}'); return }
        if (!payload.stream) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); return }
        const raw = payload.model === 'lookup-probe' ? JSON.stringify(entry) : '兼容性测试。'
        response.setHeader('Content-Type', 'text/event-stream')
        response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: raw } }] }) + '\n\ndata: [DONE]\n\n')
      } catch { response.writeHead(400); response.end() }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('兼容性检查无法启动。')
  const config = { baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: 'translation-probe', apiKey: null }
  const probe = async (): Promise<void> => {
    const connection = await client.request('test', config)
    let deltas = ''
    const translation = await client.request('translate', config, { requestId: 'probe', text: 'A compatibility check.', targetLanguage: '简体中文', mode: 'translation' }, text => { deltas += text }) as TranslateResult
    const lookup = await client.request('translate', { ...config, modelId: 'lookup-probe' }, { requestId: 'probe', text: 'bank', targetLanguage: '简体中文', mode: 'lookup' }) as TranslateResult
    const auth = await client.request('translate', { ...config, modelId: 'reject-auth' }, { requestId: 'probe', text: 'A test.', targetLanguage: '简体中文', mode: 'translation' }) as TranslateResult
    if (!connection.ok || !translation.ok || translation.text !== '兼容性测试。' || deltas !== translation.text ||
      !lookup.ok || lookup.mode !== 'lookup' || lookup.lookup?.lemma !== 'bank' || lookup.lookup.contextual !== null ||
      auth.ok || auth.error?.code !== 'auth') throw new Error('翻译模块未通过流式翻译、查词或错误处理兼容性检查。')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([probe(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('翻译模块兼容性检查超时。')), 10000) })])
  } finally { clearTimeout(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}
