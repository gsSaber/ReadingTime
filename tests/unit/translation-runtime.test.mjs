import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter, once } from 'node:events'
import { DEFAULT_STRATEGY, parseStrategy } from '../../src/translation/strategy.ts'
import { buildTranslationMessages } from '../../src/translation/llm.ts'
import { ReleaseStore } from '../../src/translation/releases.ts'
import { TranslationRuntime } from '../../src/translation/runtime.ts'
import { WorkerClient } from '../../src/translation/client.ts'

const engineSource = fileURLToPath(new URL('../../src/translation/engine.ts', import.meta.url))
const workerSource = fileURLToPath(new URL('../../src/translation/worker.ts', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')
const strategy = version => ({ ...structuredClone(DEFAULT_STRATEGY), version,
  translationPrompt: DEFAULT_STRATEGY.translationPrompt + '\nPolicy marker: ' + version })
const input = (text = 'A long sentence.', requestId = 'request') => ({ requestId, text, targetLanguage: '简体中文', mode: 'translation' })

function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'readingtime-runtime-'))
  const builtin = join(root, 'builtin.cjs')
  writeFileSync(builtin, `module.exports = require(${JSON.stringify(engineSource)})`)
  const children = []
  const factory = () => {
    const child = fork(workerSource, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: ['--experimental-strip-types', '--no-warnings'] })
    child.stderr.on('data', () => {})
    children.push(child)
    return { postMessage: message => child.send(message), kill: () => child.kill(), on: (event, listener) => child.on(event, listener) }
  }
  const store = new ReleaseStore(join(root, 'profile'), builtin)
  const runtime = new TranslationRuntime(store, factory)
  t.after(async () => {
    runtime.close()
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
    }
    rmSync(root, { recursive: true, force: true })
  })
  const policy = version => { const path = join(root, version + '.json'); writeFileSync(path, JSON.stringify(strategy(version))); return path }
  const pack = (version, source) => {
    const dir = join(root, version)
    mkdirSync(dir)
    const policy = JSON.stringify(strategy(version))
    writeFileSync(join(dir, 'strategy.json'), policy)
    writeFileSync(join(dir, 'engine.cjs'), source)
    const manifest = { format: 'readingtime-translation-update', protocolVersion: 1, version,
      strategySha256: hash(policy), engineSha256: hash(source) }
    const path = join(dir, 'manifest.json')
    writeFileSync(path, JSON.stringify(manifest))
    return path
  }
  return { root, runtime, store, factory, policy, pack }
}

async function mockModel(t) {
  const requests = []
  let releaseSlow
  const started = Promise.withResolvers()
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw)
      requests.push(body)
      res.setHeader('Content-Type', 'text/event-stream')
      res.write('data: {"choices":[{"delta":{"content":"开始"}}]}\n\n')
      const end = () => res.end('data: {"choices":[{"delta":{"content":"完成"}}]}\n\ndata: [DONE]\n\n')
      if (body.messages[1].content === 'slow') { releaseSlow = end; started.resolve() }
      else end()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { config: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId: 'mock', apiKey: null },
    requests, started: started.promise, releaseSlow: () => releaseSlow() }
}

test('strategies validate bounds, snapshot inputs and scope terminology to matching selections and languages', () => {
  const data = strategy('personal')
  data.glossary = [{ source: 'agent', target: '智能体', targetLanguage: '简体中文' }]
  const parsed = parseStrategy(data)
  data.routing.maxLookupWords = 30
  assert.equal(parsed.routing.maxLookupWords, 8)
  assert.match(buildTranslationMessages('An agent.', '简体中文', parsed)[0].content, /智能体/)
  assert.doesNotMatch(buildTranslationMessages('An agent.', 'English', parsed)[0].content, /智能体/)
  assert.doesNotMatch(buildTranslationMessages('A quiet page.', '简体中文', parsed)[0].content, /智能体/)
  assert.throws(() => parseStrategy({ ...parsed, maxContextSide: 401 }))
  assert.throws(() => parseStrategy({ ...parsed, translationTimeoutMs: 0 }))
  assert.throws(() => parseStrategy({ ...parsed, schemaVersion: 2 }))
})

test('switching versions preserves in-flight streams, supports rollback and persists the active snapshot', async t => {
  const h = harness(t)
  const mock = await mockModel(t)
  await h.runtime.initialize()
  const deltas = []
  const old = h.runtime.translate(input('slow'), mock.config, delta => deltas.push(delta))
  await mock.started
  const update = await h.runtime.install(h.policy('v2'))
  assert.equal(update.ok, true)
  const fresh = await h.runtime.translate(input('fresh'), mock.config, () => {})
  assert.equal(fresh.strategyVersion, 'v2')
  assert.match(mock.requests.at(-1).messages[0].content, /Policy marker: v2/)
  mock.releaseSlow()
  const completed = await old
  assert.equal(completed.strategyVersion, 'builtin-1')
  assert.equal(completed.text, '开始完成')
  assert.deepEqual(deltas, ['开始', '完成'])
  assert.equal((await h.runtime.rollback()).status.builtin, true)
  assert.equal((await h.runtime.rollback()).status.strategyVersion, 'v2')
  h.runtime.close()
  const restarted = new TranslationRuntime(h.store, h.factory)
  t.after(() => restarted.close())
  await restarted.initialize()
  assert.equal(restarted.status().strategyVersion, 'v2')
})

test('invalid policies, incompatible code, tampered packages and persistence failures leave the active version intact', async t => {
  const h = harness(t)
  await h.runtime.initialize()
  const invalid = join(h.root, 'invalid.json')
  writeFileSync(invalid, '{"schemaVersion":2}')
  assert.equal((await h.runtime.install(invalid)).ok, false)
  const incompatible = h.pack('bad-code', 'module.exports={protocolVersion:2}')
  assert.equal((await h.runtime.install(incompatible)).ok, false)
  const wrong = h.pack('wrong-result', 'module.exports={protocolVersion:1,testConnection:async()=>({ok:true}),translate:async()=>({ok:true,text:"wrong"})}')
  assert.equal((await h.runtime.install(wrong)).ok, false)
  const tampered = h.pack('tampered', `module.exports=require(${JSON.stringify(engineSource)})`)
  writeFileSync(join(h.root, 'tampered', 'engine.cjs'), 'throw Error("changed")')
  assert.equal((await h.runtime.install(tampered)).ok, false)
  const save = h.store.saveState.bind(h.store)
  h.store.saveState = () => { throw new Error('disk full') }
  assert.equal((await h.runtime.install(h.policy('disk-failure'))).ok, false)
  h.store.saveState = save
  assert.equal(h.runtime.status().builtin, true)
})

test('cancellation targets its own request and returns promptly while later requests still work', async t => {
  const h = harness(t)
  const mock = await mockModel(t)
  const controller = new AbortController()
  const pending = h.runtime.translate(input('slow'), mock.config, () => {}, controller.signal)
  await mock.started
  controller.abort()
  assert.equal((await pending).cancelled, true)
  assert.equal((await h.runtime.translate(input('another'), mock.config, () => {})).ok, true)
})

test('data-only routing changes take effect in the worker for automatically classified selections', async t => {
  const h = harness(t)
  const mock = await mockModel(t)
  const path = h.policy('routing-v2')
  const policy = JSON.parse(readFileSync(path, 'utf8'))
  policy.routing.maxLookupWords = 1
  writeFileSync(path, JSON.stringify(policy))
  assert.equal((await h.runtime.install(path)).ok, true)
  const selection = input('two words')
  delete selection.mode
  const result = await h.runtime.translate(selection, mock.config, () => {})
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'translation')
  assert.equal(result.strategyVersion, 'routing-v2')
})

test('executable engine updates survive data-only policy changes and recover after an unexpected worker exit', async t => {
  const h = harness(t)
  const mock = await mockModel(t)
  await h.runtime.initialize()
  const engine = `const base=require(${JSON.stringify(engineSource)}); module.exports={...base,translate:async function(r,...rest){if(r.input.text==='crash')process.exit(1);return base.translate(r,...rest)}}`
  assert.equal((await h.runtime.install(h.pack('engine-v2', engine))).ok, true)
  assert.equal((await h.runtime.install(h.policy('policy-v3'))).ok, true)
  const crashing = await h.runtime.translate(input('crash'), mock.config, () => {})
  assert.equal(crashing.ok, false)
  assert.equal((await h.runtime.translate(input('recovered'), mock.config, () => {})).ok, true)
  assert.equal(h.runtime.status().strategyVersion, 'engine-v2')
  assert.equal((await h.runtime.restoreBuiltin()).status.builtin, true)
})

test('startup falls back if an installed immutable version has been modified on disk', async t => {
  const h = harness(t)
  await h.runtime.initialize()
  const updated = await h.runtime.install(h.policy('v2'))
  writeFileSync(join(h.store.root, 'versions', updated.status.id, 'strategy.json'), '{}')
  h.runtime.close()
  const restarted = new TranslationRuntime(h.store, h.factory)
  t.after(() => restarted.close())
  await restarted.initialize()
  assert.equal(restarted.status().builtin, true)
  assert.ok(restarted.status().lastError)
  assert.equal(JSON.parse(readFileSync(join(h.store.root, 'active.json'))).active, 'builtin')
})

test('concurrent update requests are serialized and retain the correct rollback parent', async t => {
  const h = harness(t)
  await h.runtime.initialize()
  const results = await Promise.all([h.runtime.install(h.policy('v2')), h.runtime.install(h.policy('v3'))])
  assert.ok(results.every(result => result.ok))
  assert.equal(h.runtime.status().strategyVersion, 'v3')
  assert.equal((await h.runtime.rollback()).status.strategyVersion, 'v2')
})

test('retiring a worker bounds draining time even when its engine never resolves', async () => {
  const events = new EventEmitter()
  let killed = 0
  let exits = 0
  const client = new WorkerClient({ id: 'test', version: 'test', strategy: DEFAULT_STRATEGY, enginePath: '/unused' }, () => ({
    on: (event, callback) => events.on(event, callback),
    kill: () => { killed++ },
    postMessage: message => { if (message.type === 'init') queueMicrotask(() => events.emit('message', { type: 'ready' })) }
  }), () => { exits++ }, 15)
  await client.ready
  const pending = client.request('translate', { baseUrl: 'http://unused', modelId: 'unused', apiKey: null }, input())
  client.retire()
  assert.equal((await pending).ok, false)
  assert.equal(killed, 1)
  assert.equal(exits, 1)
})
