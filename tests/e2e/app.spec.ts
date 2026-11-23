import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdirSync, readdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = process.cwd()
const FIXTURE = resolve(ROOT, 'tests/fixtures/quiet-reading.pdf')
const ARTIFACTS = resolve(ROOT, 'tests/.artifacts/e2e')

// Use PDF glyph advances, independent of the HTML text layer's font/geometry.
async function proposalGeometry(path: string, pageNumber = 1) {
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const pdf = await getDocument({ data: new Uint8Array(readFileSync(path)),
    standardFontDataUrl: resolve(ROOT, 'node_modules/pdfjs-dist/standard_fonts') + '/' }).promise
  try {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const line = content.items.find((item) => 'str' in item && item.str.includes('I used this two-step strategy'))
    if (!line || !('str' in line)) throw new Error('Missing proposal line in test PDF')
    const ops = await page.getOperatorList()
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] !== OPS.showText) continue
      const glyphs = ops.argsArray[i][0] as Array<number | { unicode: string; width: number }>
      const raw = glyphs.map(g => typeof g === 'number' ? '' : g.unicode).join('')
      if (!raw.includes('I used this two-step strategy')) continue
      const first = raw.search(/\S/)
      const start = raw.indexOf('proposal')
      const positions: Array<{ start: number; end: number }> = []
      let advance = 0
      for (const glyph of glyphs) {
        if (typeof glyph === 'number') { advance -= glyph; continue }
        for (let j = 0; j < glyph.unicode.length; j++) positions.push({
          start: advance + glyph.width * j / glyph.unicode.length,
          end: advance + glyph.width * (j + 1) / glyph.unicode.length
        })
        advance += glyph.width
      }
      const origin = positions[first].start
      const unit = Math.hypot(line.transform[0], line.transform[1]) / 1000
      const viewport = page.getViewport({ scale: 1 })
      return {
        pageNumber, pageWidth: viewport.width,
        left: viewport.convertToViewportPoint(line.transform[4] + (positions[start].start - origin) * unit, line.transform[5])[0],
        right: viewport.convertToViewportPoint(line.transform[4] + (positions[start + 7].end - origin) * unit, line.transform[5])[0],
        y: viewport.convertToViewportPoint(line.transform[4], line.transform[5] + line.height * 0.45)[1]
      }
    }
    throw new Error('Missing glyph metrics in test PDF')
  } finally { await pdf.destroy() }
}

interface MockLlm {
  server: Server
  baseUrl: string
  requests: Array<{ url: string; authorization: string; body: Record<string, unknown> }>
  close: () => Promise<void>
}

async function startMockLlm(
  mode: 'stream' | 'unauthorized' | 'invalid-lookup' = 'stream',
  intervalMs = 80
): Promise<MockLlm> {
  const requests: MockLlm['requests'] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(raw)
      } catch {
        payload = {}
      }
      requests.push({
        url: request.url || '',
        authorization: String(request.headers.authorization || ''),
        body: payload
      })
      if (mode === 'unauthorized') {
        response.writeHead(401, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Invalid API key' } }))
        return
      }
      if (!request.url?.includes('/chat/completions')) {
        response.writeHead(404)
        response.end('not found')
        return
      }
      if (!payload.stream) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
        )
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const messages = payload.messages as Array<{ content: string }>
      const lookup = messages[0]?.content.includes('You explain vocabulary in a PDF reader')
      let fragments = ['阅读', '不是', '一场竞赛。', '它是两个心灵', '跨越时间的对话。']
      if (lookup) {
        const input = JSON.parse(messages[1].content)
        const english = messages[0].content.includes('in English;')
        const phrase = input.selection === 'across time'
        const content = mode === 'invalid-lookup' ? 'not valid JSON' : JSON.stringify(
          input.selection === 'It is a conversation' ? { kind: 'translation', translation: '这是一场对话。' } : {
            kind: 'lookup', lemma: phrase ? 'across time' : 'read',
            contextual: input.context ? {
              partOfSpeech: english ? 'gerund' : phrase ? '介词短语' : '动名词',
              meaning: english ? 'the activity of reading' : phrase ? '跨越时间' : '阅读这件事',
              explanation: english ? 'It functions as the subject.' : phrase ? '修饰 conversation，说明交流跨越时间。' : '此处作句子的主语，表示阅读这一活动。'
            } : null,
            common: phrase ? [{ partOfSpeech: '介词短语', meanings: ['跨越时间', '随着时间推移'] }] : [
              { partOfSpeech: english ? 'verb' : '动词', meanings: english ? ['to read written text'] : ['阅读', '理解；解读'] },
              { partOfSpeech: english ? 'noun' : '名词', meanings: english ? ['an act of reading'] : ['一次阅读'] }
            ]
          })
        fragments = content.match(/.{1,13}/gu) || []
      }
      let index = 0
      const timer = setInterval(() => {
        if (index < fragments.length) {
          response.write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: { content: fragments[index] } }]
            })}\n\n`
          )
          index += 1
          return
        }
        response.write('data: [DONE]\n\n')
        clearInterval(timer)
        response.end()
      }, intervalMs)
      response.on('close', () => clearInterval(timer))
    })
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Mock server did not start.')
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose()))
  }
}

async function launchApp(
  profileName: string,
  opts: { startupPdf?: string; reuseProfile?: boolean; executablePath?: string } = {}
): Promise<{ app: ElectronApplication; page: Page; profile: string; errors: string[] }> {
  mkdirSync(ARTIFACTS, { recursive: true })
  const profile = resolve(ARTIFACTS, `profile-${profileName}`)
  if (!opts.reuseProfile) rmSync(profile, { recursive: true, force: true })
  mkdirSync(profile, { recursive: true })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.READING_TIME_USER_DATA = profile
  const args = ['.']
  if (opts.startupPdf) args.push(opts.startupPdf)
  const app = await electron.launch({ args: opts.executablePath ? args.slice(1) : args, executablePath: opts.executablePath, cwd: ROOT, env })
  const page = await app.firstWindow()
  await app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true })
    BrowserWindow.getAllWindows()[0].focus()
  })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForSelector('.app-frame')
  return { app, page, profile, errors }
}

async function configureModel(
  page: Page,
  baseUrl: string,
  options: { expectConnection?: 'success' | 'error'; apiKey?: string } = {}
): Promise<void> {
  await page.getByRole('button', { name: '打开设置' }).click()
  await expect(page.locator('.settings-modal')).toBeVisible()
  const baseInput = page.locator('input[placeholder="https://api.openai.com/v1"]')
  await expect(baseInput).toBeVisible()
  await baseInput.fill(baseUrl)
  await page.locator('input[placeholder="例如 gpt-4o-mini"]').fill('mock-translator')
  await page.locator('input[placeholder*="无需鉴权"]').fill(options.apiKey ?? 'test-key-123')
  await expect(page.getByRole('button', { name: '保存设置' })).toBeInViewport()
  await page.getByRole('button', { name: '测试连接' }).click()
  await expect(page.locator('.test-result')).toContainText(
    options.expectConnection === 'error' ? '认证失败' : '连接成功'
  )
  await page.getByRole('button', { name: '保存设置' }).click()
  await expect(page.locator('.settings-modal')).toHaveCount(0)
}

async function selectPdfTerm(page: Page, term: string, within: string): Promise<void> {
  const coords = await page.evaluate(({ term, within }) => {
    const layer = [...document.querySelectorAll<HTMLElement>('.pdf-text-layer')]
      .find((element) => element.textContent?.includes(within))
    if (!layer) throw new Error(`No PDF text contains ${within}`)
    // A drag starting in an existing selection may move it instead of selecting new text.
    window.getSelection()?.removeAllRanges()
    const index = layer.textContent!.indexOf(term, layer.textContent!.indexOf(within))
    if (index < 0) throw new Error('Missing fixture term: ' + term)
    const range = document.createRange()
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
    let offset = 0
    let started = false
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      if (!started && index >= offset && index < offset + node.length) {
        range.setStart(node, index - offset)
        started = true
      }
      if (started && index + term.length <= offset + node.length) {
        range.setEnd(node, index + term.length - offset)
        break
      }
      offset += node.length
    }
    const rect = range.getBoundingClientRect()
    return { left: rect.left + 0.5, right: rect.right - 0.5, y: rect.top + rect.height / 2 }
  }, { term, within })
  await page.mouse.move(coords.left, coords.y)
  await page.mouse.down()
  await page.mouse.move(coords.right, coords.y, { steps: 12 })
  await page.mouse.up()
}

test('reads, translates with a real mouse selection, restores progress, and manages the library', async () => {
  const mock = await startMockLlm('stream')
  const first = await launchApp('main', { startupPdf: FIXTURE })
  let { app, page } = first
  try {
    await expect(page.locator('.doc-entry h3')).toHaveText('quiet-reading')
    await page.waitForSelector('.pdf-text-layer span', { timeout: 20_000 })
    await expect(page.locator('.page-total')).toHaveText('/ 3')

    await configureModel(page, mock.baseUrl)
    await expect(page.locator('.model-status strong')).toHaveText('mock-translator')

    await selectPdfTerm(page, 'Reading is not a race. It is a conversation', 'Reading is not a race')
    await expect(page.locator('.translation-popup')).toBeVisible()
    await expect(page.locator('.translation-text')).toHaveText(
      '阅读不是一场竞赛。它是两个心灵跨越时间的对话。'
    )
    await expect(page.locator('.translation-status')).toContainText('自动翻译完成')
    expect(mock.requests.some((request) => request.body.stream === true)).toBe(true)
    const translationRequest = mock.requests.find((request) => request.body.stream === true)
    expect(translationRequest?.authorization).toBe('Bearer test-key-123')
    expect(JSON.stringify(translationRequest?.body)).toContain('简体中文')
    await page.waitForTimeout(300)
    await page.screenshot({ path: resolve(ARTIFACTS, 'translation-result.png') })
    await page.getByRole('button', { name: '复制译文' }).click()
    const clipboardText = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(clipboardText).toBe('阅读不是一场竞赛。它是两个心灵跨越时间的对话。')

    await page.getByRole('button', { name: '调整译文外观' }).click()
    await page.locator('.mini-font-button[data-font="sans"]').click()
    await page.locator('.appearance-size button').last().click()
    await expect(page.locator('.mini-font-button[data-font="sans"]')).toHaveClass(/is-active/)
    await page.getByRole('button', { name: 'PDF 目录' }).click()
    await expect(page.locator('.translation-popup')).toHaveCount(0)
    await expect(page.locator('.outline-drawer')).toBeVisible()
    await expect(page.locator('.outline-row')).toHaveCount(3)
    await page.locator('.outline-row', { hasText: '02 · A Bridge Between Words' }).click()
    await expect(page.locator('.page-number input')).toHaveValue('2')
    await page.waitForTimeout(900)
    await page.screenshot({ path: resolve(ARTIFACTS, 'outline-navigation.png') })

    expect(first.errors).toEqual([])
    await app.close()

    const second = await launchApp('main', { reuseProfile: true })
    app = second.app
    page = second.page
    await page.waitForSelector('.pdf-text-layer span', { timeout: 20_000 })
    await expect(page.locator('.doc-entry h3')).toHaveText('quiet-reading')
    await expect(page.locator('.page-number input')).toHaveValue('2')

    await page.locator('.doc-entry').hover()
    await page.locator('.doc-menu-trigger').click()
    await page.getByRole('menuitem', { name: '重命名' }).click()
    await page.locator('.small-modal input[type="text"]').fill('安静阅读：三章')
    await page.getByRole('button', { name: '保存书名' }).click()
    await expect(page.locator('.doc-entry h3')).toHaveText('安静阅读：三章')
    await expect(page.locator('.toolbar-doc h1')).toHaveText('安静阅读：三章')

    await page.locator('.doc-entry').hover()
    await page.locator('.doc-menu-trigger').click()
    await page.getByRole('menuitem', { name: '从书架删除' }).click()
    await expect(page.getByText('从书架删除？')).toBeVisible()
    await page.getByRole('button', { name: '删除这本书' }).click()
    await expect(page.getByText('让世界，')).toBeVisible()
    await expect(page.locator('.doc-entry')).toHaveCount(0)
    expect(second.errors).toEqual([])
    const settingsFile = JSON.parse(
      readFileSync(resolve(second.profile, 'data', 'settings.json'), 'utf8')
    )
    expect(settingsFile.preferences.translationFont).toBe('sans')
    expect(settingsFile.preferences.translationFontSize).toBe(18)
    const index = JSON.parse(readFileSync(resolve(second.profile, 'data', 'library.json'), 'utf8'))
    expect(index.entries).toHaveLength(0)
    expect(existsSync(resolve(second.profile, 'library'))).toBe(true)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test('shows helpful errors for a missing model and rejected credentials', async () => {
  const mock = await startMockLlm('unauthorized')
  const session = await launchApp('errors', { startupPdf: FIXTURE })
  const { app, page } = session
  try {
    await page.waitForSelector('.pdf-text-layer span', { timeout: 20_000 })

    await selectPdfTerm(page, 'Reading is not a race. It is a conversation', 'Reading is not a race')
    await expect(page.locator('.translation-popup')).toBeVisible()
    await expect(page.locator('.translation-error')).toContainText('还没有配置翻译模型')
    await expect(page.getByRole('button', { name: /打开模型设置/ })).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: resolve(ARTIFACTS, 'translation-not-configured.png') })

    await page.locator('.pdf-page-content').first().click({ position: { x: 8, y: 8 } })
    await expect(page.locator('.translation-popup')).toHaveCount(0)
    await configureModel(page, mock.baseUrl, { expectConnection: 'error' })
    await selectPdfTerm(page, 'When we slow down, a page can become a room', 'When we slow down')
    await expect(page.locator('.translation-popup')).toBeVisible()
    await expect(page.locator('.translation-error')).toContainText('认证失败')
    await page.waitForTimeout(300)
    await page.screenshot({ path: resolve(ARTIFACTS, 'translation-auth-error.png') })
    expect(session.errors).toEqual([])
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test('feedback follows each completed result and can be edited or withdrawn', async () => {
  const mock = await startMockLlm('stream', 5)
  const { app, page, profile } = await launchApp('result-feedback', { startupPdf: FIXTURE })
  const dir = resolve(profile, 'data', 'translation-feedback')
  const files = () => existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith('.json')) : []
  const records = () => files().map(name => JSON.parse(readFileSync(resolve(dir, name), 'utf8')))
  try {
    await configureModel(page, mock.baseUrl, { apiKey: '' })
    await page.waitForSelector('.pdf-text-layer span')
    await selectPdfTerm(page, 'Reading is not a race. It is a conversation', 'Reading is not a race')
    const up = page.getByRole('button', { name: '点赞', exact: true })
    const down = page.getByRole('button', { name: '点踩', exact: true })
    await expect(up).toBeVisible()
    expect(files()).toHaveLength(0)
    await down.click()
    await page.getByRole('textbox', { name: '点踩理由' }).fill('请保留原句的语气')
    await page.getByRole('button', { name: '保存理由' }).click()
    await expect.poll(() => records()[0]?.reason).toBe('请保留原句的语气')
    const [first] = records()
    expect(first).toMatchObject({ vote: 'down', mode: 'translation', modelId: 'mock-translator',
      strategyVersion: 'builtin-1', runtimeId: 'builtin', text: await page.locator('.translation-text').innerText() })
    await up.click()
    await expect.poll(() => records()).toMatchObject([{ id: first.id, vote: 'up', reason: '' }])
    await up.click()
    await expect.poll(files).toHaveLength(0)
    await up.click()
    await expect(up).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: '关闭翻译' }).click()
    await selectPdfTerm(page, 'Reading', 'Reading is not a race')
    await expect(up).toHaveAttribute('aria-pressed', 'false')
    const selection = await page.locator('.translation-source p').innerText()
    const lookupRequest = mock.requests.at(-1)?.body.messages as Array<{content: string}>
    expect(JSON.parse(lookupRequest[1].content).selection).toBe(selection)
    await down.click()
    await expect.poll(() => records().find(entry => entry.mode === 'lookup')).toMatchObject({
      source: selection, vote: 'down', reason: '', context: { after: expect.stringContaining('is not a race') }
    })
    expect(files()).toHaveLength(2)
    expect(records().some(entry => entry.id === first.id && entry.vote === 'up')).toBe(true)
  } finally { await app.close(); await mock.close() }
})

test('switching model endpoints scopes credentials and a failed save preserves active preferences', async () => {
  const first = await startMockLlm()
  const second = await startMockLlm()
  const { app, page, profile } = await launchApp('model-switch', { startupPdf: FIXTURE })
  try {
    await configureModel(page, first.baseUrl)
    await page.getByRole('button', { name: '打开设置' }).click()
    await page.getByRole('button', { name: '模型服务', exact: true }).click()
    const testButton = page.getByRole('button', { name: '测试连接' })
    const address = page.getByPlaceholder('https://api.openai.com/v1', { exact: true })
    await address.fill(first.baseUrl + '/chat/completions')
    await testButton.click()
    await expect.poll(() => first.requests.length).toBe(2)
    expect(first.requests.at(-1)?.authorization).toBe('Bearer test-key-123')
    await page.getByRole('button', { name: '移除已保存的 API Key' }).click()
    await testButton.click()
    await expect.poll(() => first.requests.at(-1)?.authorization).toBe('')
    await page.getByRole('button', { name: '撤销移除' }).click()
    await address.fill(second.baseUrl)
    await testButton.click()
    await expect.poll(() => second.requests.at(-1)?.authorization).toBe('')
    await page.getByRole('button', { name: '保存设置' }).click()
    await expect(page.locator('.settings-modal')).toHaveCount(0)
    expect((await page.evaluate(() => window.readingTime.settings.get())).llm).toMatchObject({
      apiKeyConfigured: false, baseUrl: second.baseUrl
    })

    // Force the atomic write to fail without changing real disk permissions.
    const temporaryPath = resolve(profile, 'data', 'settings.json.tmp')
    mkdirSync(temporaryPath)
    await page.getByRole('button', { name: /^阅读主题：/ }).click()
    await expect(page.getByText('设置保存失败，请检查应用的存储权限。', { exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-reader-tone', 'original')
    expect((await page.evaluate(() => window.readingTime.settings.get())).preferences.readerTone).toBe('original')
    rmSync(temporaryPath, { recursive: true })
    await page.getByRole('button', { name: /^阅读主题：/ }).click()
    await expect(page.locator('html')).toHaveAttribute('data-reader-tone', 'sepia')
  } finally { await app.close(); await first.close(); await second.close() }
})

test('adopts strategy and executable updates without restarting the reader, drains streams and persists rollback', async () => {
  const mock = await startMockLlm('stream', 250)
  let session = await launchApp('runtime-update', { startupPdf: FIXTURE })
  let { app, page } = session
  try {
    await configureModel(page, mock.baseUrl)
    const policyPath = resolve(session.profile, 'personal-strategy.json')
    const policy = JSON.parse(readFileSync(resolve(ROOT, 'src/translation/default-strategy.json'), 'utf8'))
    policy.version = 'e2e-policy-v2'
    policy.translationPrompt += '\nPolicy marker: e2e-policy-v2'
    writeFileSync(policyPath, JSON.stringify(policy))
    const originalPid = await app.evaluate(() => process.pid)
    const contentsId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.id)
    await page.evaluate(() => {
      Reflect.set(window, 'runtimeSentinel', 'same-reading-window')
      Reflect.set(window, 'oldTranslation', window.readingTime.translate.start({
        requestId: 'old-stream', text: 'An ongoing translation.', targetLanguage: '简体中文', mode: 'translation'
      }))
    })
    await expect.poll(() => mock.requests.filter(r => r.body.stream).length).toBe(1)
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
    }, policyPath)
    await page.getByRole('button', { name: '打开设置' }).click()
    await page.getByRole('button', { name: '翻译偏好', exact: true }).click()
    await page.getByRole('button', { name: '导入翻译更新', exact: true }).click()
    await expect(page.getByRole('region', { name: '翻译版本' })).toContainText('e2e-policy-v2')
    const oldResult = await page.evaluate(() => Reflect.get(window, 'oldTranslation'))
    expect(oldResult.ok).toBe(true)
    expect(oldResult.strategyVersion).toBe('builtin-1')
    const fresh = await page.evaluate(() => window.readingTime.translate.start({
      requestId: 'new-stream', text: 'A new translation.', targetLanguage: '简体中文', mode: 'translation'
    }))
    expect(fresh.strategyVersion).toBe('e2e-policy-v2')
    expect(JSON.stringify(mock.requests.at(-1)?.body)).toContain('Policy marker: e2e-policy-v2')
    expect(await app.evaluate(() => process.pid)).toBe(originalPid)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.id)).toBe(contentsId)
    expect(await page.evaluate(() => Reflect.get(window, 'runtimeSentinel'))).toBe('same-reading-window')
    await page.getByRole('button', { name: '回滚上一版本', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.readingTime.translationRuntime.status())).toMatchObject({ builtin: true })

    const output = resolve(session.profile, 'code-update')
    execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings',
      'scripts/build-translation-update.mjs', '--policy', policyPath, '--out', output,
      '--engine', 'src/translation/engine.ts', '--version', 'e2e-code-v2'], { cwd: ROOT, stdio: 'pipe' })
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
    }, resolve(output, 'manifest.json'))
    await page.getByRole('button', { name: '导入翻译更新', exact: true }).click()
    await expect(page.getByRole('region', { name: '翻译版本' })).toContainText('e2e-code-v2')
    expect((await page.evaluate(() => window.readingTime.translate.start({
      requestId: 'code-update', text: 'A code update.', targetLanguage: '简体中文', mode: 'translation'
    }))).runtimeVersion).toBe('e2e-code-v2')
    expect(await app.evaluate(() => process.pid)).toBe(originalPid)
    expect(session.errors).toEqual([])
    await app.close()
    session = await launchApp('runtime-update', { reuseProfile: true })
    app = session.app
    page = session.page
    expect((await page.evaluate(() => window.readingTime.translationRuntime.status())).version).toBe('e2e-code-v2')
    expect((await page.evaluate(() => window.readingTime.translationRuntime.rollback())).status.builtin).toBe(true)
    await expect(page.locator('.doc-entry h3')).toHaveText('quiet-reading')
    expect(session.errors).toEqual([])
  } finally { await app.close().catch(() => {}); await mock.close() }
})

test('switches the whole reading theme and restores it after restarting', async () => {
  const first = await launchApp('themes', { startupPdf: FIXTURE })
  let { app, page } = first
  try {
    await page.waitForSelector('.pdf-page-content.is-rendered')
    const sidebarColors: string[] = []
    for (const tone of ['original', 'sepia', 'night']) {
      await expect(page.locator('html')).toHaveAttribute('data-reader-tone', tone)
      await expect(page.locator('.reader-pane')).toHaveAttribute('data-tone', tone)
      sidebarColors.push(await page.locator('.library-sidebar').evaluate((el) => getComputedStyle(el).backgroundColor))
      const nativeTone = await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)
      expect(nativeTone).toBe(tone === 'night' ? 'dark' : 'light')
      await expect(page.locator('.pdf-scroll')).toHaveCSS('background-color', {
        original: 'rgb(230, 233, 237)', sepia: 'rgb(223, 210, 187)', night: 'rgb(16, 17, 19)'
      }[tone]!)
      await expect(page.locator('.pdf-page-canvas').first()).toHaveCSS('filter', {
        original: 'none', sepia: 'sepia(0.42) saturate(0.75) brightness(0.96)',
        night: 'invert(0.91) hue-rotate(180deg) brightness(0.9) contrast(0.94)'
      }[tone]!)
      await page.screenshot({ path: resolve(ARTIFACTS, `theme-${tone}.png`) })
      if (tone !== 'night') await page.getByRole('button', { name: /^阅读主题：/ }).click()
    }
    expect(new Set(sidebarColors).size).toBe(3)
    await expect(page.locator('.pdf-page-canvas').first()).toHaveCSS('filter', /invert/)
    await app.close()

    const second = await launchApp('themes', { reuseProfile: true })
    app = second.app
    page = second.page
    await page.waitForSelector('.pdf-page-content.is-rendered')
    await expect(page.locator('html')).toHaveAttribute('data-reader-tone', 'night')
    await page.getByRole('button', { name: '打开设置' }).click()
    await page.getByRole('button', { name: '阅读与隐私' }).click()
    await expect(page.locator('.tone-card.tone-night')).toHaveAttribute('aria-pressed', 'true')
    await page.locator('.tone-card.tone-sepia').click()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-reader-tone', 'night')
    await page.getByRole('button', { name: '打开设置' }).click()
    await page.getByRole('button', { name: '阅读与隐私' }).click()
    await page.locator('.tone-card.tone-sepia').click()
    await page.getByRole('button', { name: '保存设置' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-reader-tone', 'sepia')
    await expect(page.locator('.reader-pane')).toHaveAttribute('data-tone', 'sepia')
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')
    expect([...first.errors, ...second.errors]).toEqual([])
  } finally {
    await app.close().catch(() => {})
  }
})

test('packaged macOS app uses its own identity and opens PDFs', async () => {
  if (!process.env.READING_TIME_TEST_PACKAGED) test.skip()
  const profile = resolve(ARTIFACTS, 'profile-packaged')
  rmSync(profile, { recursive: true, force: true })
  const env = { ...process.env, READING_TIME_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    executablePath: resolve(ROOT, 'release/build.noindex/mac-arm64/阅读时光.app/Contents/MacOS/阅读时光'),
    args: [FIXTURE], cwd: ROOT, env
  })
  const mock = await startMockLlm('stream', 5)
  try {
    const page = await app.firstWindow()
    const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))
    expect(identity.packaged).toBe(true)
    expect(identity.version).toBe(JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version)
    const bundleId = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', resolve(ROOT, 'release/build.noindex/mac-arm64/阅读时光.app/Contents/Info.plist')], { encoding: 'utf8' }).trim()
    expect(bundleId).toBe('com.readingtime.reader')
    await expect(page.locator('.toolbar-doc h1')).toHaveText('quiet-reading')
    await page.waitForSelector('.pdf-page-content.is-rendered')
    await page.getByRole('button', { name: /^阅读主题：/ }).click()
    await expect(page.locator('html')).toHaveAttribute('data-reader-tone', 'sepia')
    await expect(page.getByRole('separator', { name: '调整书架宽度' })).toBeVisible()
    await page.getByRole('scrollbar', { name: 'PDF 阅读滚动条' }).focus()
    await page.keyboard.press('End')
    await expect(page.locator('.page-number input')).toHaveValue('3')
    // Exercise the ASAR bootstrap and an executable module outside the .app.
    // An ad-hoc signed test bundle must not require interactive Keychain access.
    await configureModel(page, mock.baseUrl, { apiKey: '' })
    expect((await page.evaluate(() => window.readingTime.translationRuntime.status())).builtin).toBe(true)
    const policy = JSON.parse(readFileSync(resolve(ROOT, 'src/translation/default-strategy.json'), 'utf8'))
    policy.version = 'packaged-policy-v2'
    policy.translationPrompt += '\nPackaged runtime marker'
    const policyPath = resolve(profile, 'strategy.json')
    writeFileSync(policyPath, JSON.stringify(policy))
    const updateDir = resolve(profile, 'update')
    execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings',
      'scripts/build-translation-update.mjs', '--policy', policyPath, '--out', updateDir,
      '--engine', 'src/translation/engine.ts', '--version', 'packaged-engine-v2'], { cwd: ROOT, stdio: 'pipe' })
    const pid = await app.evaluate(() => process.pid)
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
    }, resolve(updateDir, 'manifest.json'))
    expect((await page.evaluate(() => window.readingTime.translationRuntime.importUpdate())).ok).toBe(true)
    const result = await page.evaluate(() => window.readingTime.translate.start({
      requestId: 'packaged-module', text: 'A packaged update.', targetLanguage: '简体中文', mode: 'translation'
    }))
    expect(result.ok).toBe(true)
    expect(result.runtimeVersion).toBe('packaged-engine-v2')
    expect(JSON.stringify(mock.requests.at(-1)?.body)).toContain('Packaged runtime marker')
    expect(await app.evaluate(() => process.pid)).toBe(pid)
    expect((await page.evaluate(() => window.readingTime.translationRuntime.restoreBuiltin())).status.builtin).toBe(true)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test('opens an existing book from macOS and accepts files after reopening its window', async () => {
  const session = await launchApp('open-file', { startupPdf: FIXTURE })
  const { app, page } = session
  try {
    await page.waitForSelector('.pdf-page-content.is-rendered')
    const otherPdf = resolve(session.profile, 'second-book.pdf')
    writeFileSync(otherPdf, Buffer.concat([readFileSync(FIXTURE), Buffer.from('\n% second book\n')]))
    await app.evaluate(({ app }, path) => {
      app.emit('open-file', { preventDefault() {} }, path)
    }, otherPdf)
    await expect(page.locator('.toolbar-doc h1')).toHaveText('second-book')
    await app.evaluate(({ app }, path) => {
      app.emit('open-file', { preventDefault() {} }, path)
    }, FIXTURE)
    await expect(page.locator('.toolbar-doc h1')).toHaveText('quiet-reading')
    await expect(page.locator('.doc-entry')).toHaveCount(2)
    await expect(page.locator('.toast')).not.toHaveClass(/toast-error/)

    const newWindow = app.waitForEvent('window')
    await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      await new Promise<void>((resolveClosed) => {
        window.once('closed', resolveClosed)
        window.close()
      })
    })
    await app.evaluate(({ app }, path) => {
      app.emit('open-file', { preventDefault() {} }, path)
    }, otherPdf)
    const reopened = await newWindow
    await expect(reopened.locator('.toolbar-doc h1')).toHaveText('second-book')
    await expect(reopened.locator('.doc-entry')).toHaveCount(2)
    await reopened.waitForSelector('.pdf-page-content.is-rendered')
    expect(session.errors).toEqual([])
  } finally {
    await app.close().catch(() => {})
  }
})

test('drags the translation popup without losing its position during streaming or retries', async () => {
  const mock = await startMockLlm('stream', 300)
  const session = await launchApp('popup-drag', { startupPdf: FIXTURE })
  const { app, page } = session
  try {
    await page.waitForSelector('.pdf-text-layer span')
    await configureModel(page, mock.baseUrl)
    await selectPdfTerm(page, 'Notes on attention, translation, and the pages that stay with us.', 'Notes on attention')
    const popup = page.locator('.translation-popup')
    await expect(popup).toHaveClass(/is-streaming/)
    const before = await popup.boundingBox()
    const handle = await page.getByRole('button', { name: '移动翻译窗口' }).boundingBox()
    if (!before || !handle) throw new Error('Missing translation drag handle')
    await page.mouse.move(handle.x + 55, handle.y + 12)
    await page.mouse.down()
    await page.mouse.move(handle.x + 145, handle.y - 78, { steps: 12 })
    await page.mouse.up()
    await expect.poll(async () => (await popup.boundingBox())!.x).toBeCloseTo(before.x + 90, 0)
    await expect.poll(async () => (await popup.boundingBox())!.y).toBeCloseTo(before.y - 90, 0)
    const moved = (await popup.boundingBox())!
    await expect(page.locator('.translation-status')).toContainText('自动翻译完成')
    await expect.poll(async () => (await popup.boundingBox())!.y).toBeCloseTo(moved.y, 0)

    await page.getByRole('button', { name: '重新翻译' }).click()
    await expect(popup).toHaveClass(/is-streaming/)
    await expect(page.locator('.translation-status')).toContainText('自动翻译完成')
    await expect.poll(async () => (await popup.boundingBox())!.x).toBeCloseTo(moved.x, 0)
    await expect.poll(async () => (await popup.boundingBox())!.y).toBeCloseTo(moved.y, 0)
    await page.getByRole('button', { name: '移动翻译窗口' }).focus()
    await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => (await popup.boundingBox())!.x).toBeCloseTo(moved.x - 10, 0)
    await expect(page.locator('.page-number input')).toHaveValue('1')

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1020, 680))
    await expect.poll(async () => {
      const box = (await popup.boundingBox())!
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      return box.x >= 14 && box.y >= 44 && box.x + box.width <= viewport.width - 13 && box.y + box.height <= viewport.height - 13
    }).toBe(true)
    await page.getByRole('button', { name: '复制译文' }).click()
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain('跨越时间的对话')
    await page.screenshot({ path: resolve(ARTIFACTS, 'draggable-translation.png') })
    expect(session.errors).toEqual([])
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test('drags the PDF scrollbar and resizes the sidebar while preserving progress and width', async () => {
  const first = await launchApp('reading-controls', { startupPdf: FIXTURE })
  let { app, page } = first
  try {
    await page.waitForSelector('.pdf-page-content.is-rendered')
    const bar = page.getByRole('scrollbar', { name: 'PDF 阅读滚动条' })
    await expect(bar).toHaveAttribute('aria-disabled', 'false')
    const track = (await bar.boundingBox())!
    let thumb = (await page.locator('.pdf-scrollbar-thumb').boundingBox())!
    await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
    await page.mouse.down()
    await page.mouse.move(thumb.x + thumb.width / 2, track.y + track.height - 1, { steps: 15 })
    await page.mouse.up()
    await expect(bar).toHaveAttribute('aria-valuenow', '100')
    await expect(page.locator('.page-number input')).toHaveValue('3')
    thumb = (await page.locator('.pdf-scrollbar-thumb').boundingBox())!
    await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
    await page.mouse.down()
    await page.mouse.move(thumb.x + thumb.width / 2, track.y, { steps: 15 })
    await page.mouse.up()
    await expect(bar).toHaveAttribute('aria-valuenow', '0')
    await expect(page.locator('.page-number input')).toHaveValue('1')
    await bar.focus()
    await page.keyboard.press('End')
    await expect(page.locator('.page-number input')).toHaveValue('3')
    await page.keyboard.press('Home')
    await expect(page.locator('.page-number input')).toHaveValue('1')

    await page.locator('.page-number input').fill('2')
    await page.locator('.page-number input').press('Enter')
    await expect.poll(() => page.evaluate(() => {
      const root = document.querySelector('.pdf-scroll')!
      return Math.round(document.querySelector('[data-page="2"]')!.getBoundingClientRect().top - root.getBoundingClientRect().top)
    })).toBe(18)

    const splitter = page.getByRole('separator', { name: '调整书架宽度' })
    const handle = (await splitter.boundingBox())!
    const width = await page.locator('.library-panel').evaluate((el) => el.getBoundingClientRect().width)
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 150)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 + 70, handle.y + 150, { steps: 14 })
    await page.mouse.up()
    await expect(splitter).toHaveAttribute('aria-valuenow', String(width + 70))
    await expect(page.locator('.page-number input')).toHaveValue('2')
    await expect.poll(() => page.evaluate(() => {
      const root = document.querySelector('.pdf-scroll')!
      return Math.round(document.querySelector('[data-page="2"]')!.getBoundingClientRect().top - root.getBoundingClientRect().top)
    })).toBe(18)
    await splitter.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(splitter).toHaveAttribute('aria-valuenow', String(width + 60))
    await expect(page.locator('.page-number input')).toHaveValue('2')
    await page.getByRole('button', { name: '收起书架', exact: true }).click()
    await page.getByRole('button', { name: '展开书架', exact: true }).click()
    await expect(splitter).toHaveAttribute('aria-valuenow', String(width + 60))
    await expect.poll(() => page.evaluate(() => {
      const root = document.querySelector('.pdf-scroll') as HTMLElement
      const current = document.querySelector('[data-page="2"]') as HTMLElement
      const canvas = current.querySelector('canvas')!
      return current.clientWidth <= root.clientWidth - 70 && Math.abs(canvas.getBoundingClientRect().width - current.clientWidth) < 2
    })).toBe(true)
    await page.locator('[data-page="2"] .pdf-page-content.is-rendered').waitFor()
    await page.screenshot({ path: resolve(ARTIFACTS, 'resizable-sidebar-scrollbar.png') })
    expect(first.errors).toEqual([])
    await app.close()
    const second = await launchApp('reading-controls', { reuseProfile: true })
    app = second.app
    page = second.page
    await expect(page.getByRole('separator', { name: '调整书架宽度' })).toHaveAttribute('aria-valuenow', String(width + 60))
    await expect(page.locator('.page-number input')).toHaveValue('2')
    await page.waitForSelector('.pdf-page-content.is-rendered')
    expect(second.errors).toEqual([])
  } finally {
    await app.close().catch(() => {})
  }
})

test('edits the zoom percentage and keeps the reading position', async () => {
  const session = await launchApp('zoom-input', { startupPdf: FIXTURE })
  const { app, page } = session
  try {
    await page.waitForSelector('.pdf-page-content.is-rendered')
    await page.locator('.page-number input').fill('2')
    await page.locator('.page-number input').press('Enter')
    await expect.poll(() => page.evaluate(() => {
      const root = document.querySelector('.pdf-scroll')!
      return Math.round(document.querySelector('[data-page="2"]')!.getBoundingClientRect().top - root.getBoundingClientRect().top)
    })).toBe(18)
    const canvas = page.locator('[data-page="2"] canvas')
    await page.locator('[data-page="2"] .pdf-page-content.is-rendered').waitFor()
    const originalWidth = (await canvas.boundingBox())!.width
    const input = page.getByRole('textbox', { name: '缩放比例（%）' })
    await input.fill('125.5')
    await input.press('Enter')
    await expect(input).toHaveValue('125.5%')
    await expect.poll(async () => (await canvas.boundingBox())!.width / originalWidth).toBeCloseTo(1.255, 2)
    await expect(page.locator('.page-number input')).toHaveValue('2')
    await input.fill('140%')
    await input.press('Tab')
    await expect(input).toHaveValue('140%')
    await expect.poll(async () => (await canvas.boundingBox())!.width / originalWidth).toBeCloseTo(1.4, 2)
    for (const value of ['', 'abc', '12abc']) {
      await input.fill(value)
      await input.press('Enter')
      await expect(input).toHaveValue('140%')
    }
    await input.fill('200')
    await input.press('Escape')
    await expect(input).toHaveValue('140%')
    await expect.poll(async () => (await canvas.boundingBox())!.width / originalWidth).toBeCloseTo(1.4, 2)
    await page.getByRole('button', { name: '放大', exact: true }).click()
    await expect(input).toHaveValue('150%')
    await page.getByRole('button', { name: '缩小', exact: true }).click()
    await expect(input).toHaveValue('140%')
    await input.fill('999')
    await input.press('Enter')
    await expect(input).toHaveValue('260%')
    await expect(page.getByRole('button', { name: '放大', exact: true })).toBeDisabled()
    await input.fill('1')
    await input.press('Enter')
    await expect(input).toHaveValue('50%')
    await expect(page.getByRole('button', { name: '缩小', exact: true })).toBeDisabled()
    await page.keyboard.press('Meta+0')
    await expect(input).toHaveValue('100%')
    await expect.poll(async () => (await canvas.boundingBox())!.width / originalWidth).toBeCloseTo(1, 2)
    expect(session.errors).toEqual([])
  } finally { await app.close().catch(() => {}) }
})

test('explains vocabulary with the selected occurrence context and preserves translation controls', async () => {
  const mock = await startMockLlm('stream', 8)
  const session = await launchApp('vocabulary', { startupPdf: FIXTURE })
  const { app, page } = session
  try {
    await page.waitForSelector('.pdf-text-layer span')
    await configureModel(page, mock.baseUrl)
    await selectPdfTerm(page, 'Reading', 'Reading is not a race')
    await expect(page.locator('.vocabulary-contextual')).toContainText('动名词')
    await expect(page.locator('.vocabulary-contextual')).toContainText('阅读这件事')
    await expect(page.locator('.vocabulary-common')).toContainText('动词')
    await expect(page.locator('.vocabulary-common')).toContainText('理解；解读')
    await expect(page.locator('.translation-status')).toContainText('词语释义完成')
    await expect(page.getByRole('group', { name: '选区解读方式' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '原文翻译', exact: true })).toHaveCount(0)
    await expect(page.locator('.vocabulary-context-source')).toHaveCount(0)
    const lookupRequests = () => mock.requests.filter((req) => JSON.stringify(req.body.messages).includes('You explain vocabulary'))
    const firstInput = JSON.parse((lookupRequests()[0].body.messages as Array<{ content: string }>)[1].content)
    expect(firstInput.selection).toBe('Reading')
    expect(firstInput.context.after).toContain('is not a race')
    expect(firstInput.context.before.length + firstInput.context.after.length).toBeLessThanOrEqual(800)

    const withoutContext = await page.evaluate(() => window.readingTime.translate.start({
      requestId: 'no-context', text: 'Reading', targetLanguage: '简体中文', context: { before: '', after: '' }
    }))
    expect(withoutContext.lookup?.contextual).toBeNull()
    const popup = page.locator('.translation-popup')
    const original = (await popup.boundingBox())!
    const handle = (await page.getByRole('button', { name: '移动翻译窗口' }).boundingBox())!
    await page.mouse.move(handle.x + 40, handle.y + 12)
    await page.mouse.down()
    await page.mouse.move(handle.x + 100, handle.y + 12, { steps: 10 })
    await page.mouse.up()
    await page.getByRole('button', { name: '重新查询释义' }).click()
    await expect(page.locator('.translation-status')).toContainText('词语释义完成')
    await expect.poll(async () => (await popup.boundingBox())!.x).toBeCloseTo(original.x + 60, 0)

    await page.getByRole('button', { name: '复制释义' }).click()
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain('此处用法\n动名词 · 阅读这件事')
    await page.getByLabel('目标语言', { exact: true }).selectOption('English')
    await expect(page.locator('.vocabulary-contextual')).toContainText('gerund')
    await expect(page.locator('.vocabulary-common')).toContainText('to read written text')
    await page.getByLabel('目标语言', { exact: true }).selectOption('简体中文')
    await expect(page.locator('.vocabulary-contextual')).toContainText('动名词')
    await page.screenshot({ path: resolve(ARTIFACTS, 'contextual-vocabulary.png') })

    const count = lookupRequests().length
    // Expose the next word before dragging on the PDF underneath the floating card.
    const titleBar = page.getByRole('button', { name: '移动翻译窗口' })
    await titleBar.focus()
    for (let i = 0; i < 12; i++) await titleBar.press('Shift+ArrowLeft')
    await selectPdfTerm(page, 'Reading', 'The Quiet Art of Reading')
    await expect.poll(() => lookupRequests().length).toBe(count + 1)
    await expect(page.locator('.vocabulary-common')).toBeVisible()
    const secondInput = JSON.parse((lookupRequests().at(-1)!.body.messages as Array<{ content: string }>)[1].content)
    expect(secondInput.context).not.toEqual(firstInput.context)

    await page.getByRole('button', { name: '关闭翻译' }).click()
    await selectPdfTerm(page, 'across time', 'across time')
    await expect(page.locator('.vocabulary-contextual')).toContainText('介词短语')
    await expect(page.locator('.vocabulary-common')).toContainText('随着时间推移')
    await expect(page.locator('.translation-text')).toHaveCount(0)

    await page.getByRole('button', { name: '关闭翻译' }).click()
    await selectPdfTerm(page, 'It is a conversation', 'It is a conversation')
    await expect(page.locator('.translation-text')).toHaveText('这是一场对话。')
    await expect(page.locator('.vocabulary-entry')).toHaveCount(0)
    expect(session.errors).toEqual([])
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test('handles invalid context and malformed vocabulary responses without exposing JSON', async () => {
  const mock = await startMockLlm('invalid-lookup', 8)
  const session = await launchApp('vocabulary-errors', { startupPdf: FIXTURE })
  const { app, page } = session
  try {
    await page.waitForSelector('.pdf-text-layer span')
    await configureModel(page, mock.baseUrl)
    await selectPdfTerm(page, 'Reading', 'Reading is not a race')
    await expect(page.locator('.translation-error')).toContainText('完整的词语释义')
    await expect(page.locator('.translation-result')).not.toContainText('not valid JSON')
    await page.getByRole('button', { name: '重新查询释义' }).click()
    await expect(page.locator('.translation-error')).toContainText('完整的词语释义')
    const invalid = await page.evaluate(() => window.readingTime.translate.start({
      requestId: 'oversized-context', text: 'Reading', targetLanguage: '简体中文', context: { before: 'a'.repeat(401), after: '' }
    }))
    expect(invalid.error?.code).toBe('bad_request')
    expect(session.errors).toEqual([])
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

for (const realPdf of [false, true]) {
  test(`selects the complete painted proposal and copies it from the context menu (${realPdf ? 'original book' : 'kerning fixture'})`, async () => {
    if (realPdf && !process.env.READING_TIME_SELECTION_PDF) test.skip()
    const path = realPdf ? process.env.READING_TIME_SELECTION_PDF! : resolve(ROOT, 'tests/fixtures/selection-proposal.pdf')
    const geometry = await proposalGeometry(path, realPdf ? 58 : 1)
    const session = await launchApp(`selection-${realPdf}`, { startupPdf: path })
    const { app, page } = session
    try {
      await page.waitForSelector('.pdf-page-content.is-rendered')
      await page.evaluate(() => window.readingTime.settings.save({ preferences: { autoTranslate: false } }))
      await page.reload()
      await page.waitForSelector('.pdf-page-content.is-rendered')
      if (realPdf) {
        await page.locator('.page-number input').fill('58')
        await page.locator('.page-number input').press('Enter')
      }
      const shell = page.locator(`[data-page="${geometry.pageNumber}"]`)
      await shell.locator('.pdf-page-content.is-rendered').waitFor()
      await app.evaluate(({ app, BrowserWindow }) => {
        app.focus({ steal: true })
        const window = BrowserWindow.getAllWindows()[0]
        window.focus()
        window.webContents.focus()
      })
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
      // Each painted word has its own position; preceding font metrics cannot
      // stretch a word's selection into the preceding or following word.
      await expect(shell.locator('.pdf-text-layer span').filter({ hasText: /^proposal$/ }).first()).toBeVisible()
      for (const zoom of [1, 1.6]) {
        if (zoom > 1) {
          for (let i = 0; i < 6; i++) await page.getByRole('button', { name: '放大', exact: true }).click()
          await shell.locator('.pdf-page-content.is-rendered').waitFor()
        }
        const canvas = (await shell.locator('canvas').boundingBox())!
        const scale = canvas.width / geometry.pageWidth
        // Mouse events use integer CSS pixels. Stay just inside the painted
        // word, rather than letting rounding hit the neighbouring space.
        const x1 = canvas.x + geometry.left * scale + 0.8
        const x2 = canvas.x + geometry.right * scale - 0.8
        const y = canvas.y + geometry.y * scale
        // Scroll vertically to the line without changing its horizontal origin.
        const proposals = shell.locator('.pdf-text-layer span').filter({ hasText: /^proposal$/ })
        const index = await proposals.evaluateAll((items, point) => {
          let best = 0, distance = Infinity
          items.forEach((item, i) => {
            const rect = item.getBoundingClientRect()
            const d = Math.abs(rect.top + rect.height / 2 - point.y) + Math.abs(rect.left - point.x)
            if (d < distance) { best = i; distance = d }
          })
          return best
        }, { x: x1, y })
        await proposals.nth(index).scrollIntoViewIfNeeded()
        const newCanvas = (await shell.locator('canvas').boundingBox())!
        const targetY = y + newCanvas.y - canvas.y
        const word = (await proposals.nth(index).boundingBox())!
        expect(Math.abs(word.x - (newCanvas.x + geometry.left * scale))).toBeLessThan(0.1)
        expect(Math.abs(word.width - (geometry.right - geometry.left) * scale)).toBeLessThan(0.1)
        // Focus the document with a real click before dragging; macOS can
        // otherwise use the first mouse gesture only to activate its window.
        await page.mouse.click(newCanvas.x + 12, targetY)
        await page.evaluate(() => window.getSelection()?.removeAllRanges())
        await page.mouse.move(x1 + newCanvas.x - canvas.x, targetY)
        await page.mouse.down()
        await page.mouse.move(x2 + newCanvas.x - canvas.x, targetY, { steps: 14 })
        await page.mouse.up()
        await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('proposal')
        // A drag starting inside an existing selection invokes native text
        // drag-and-drop, so clear the previous selection before reversing.
        await page.mouse.click(newCanvas.x + 12, targetY)
        await page.evaluate(() => window.getSelection()?.removeAllRanges())
        await page.mouse.move(x2 + newCanvas.x - canvas.x, targetY)
        await page.mouse.down()
        await page.mouse.move(x1 + newCanvas.x - canvas.x, targetY, { steps: 14 })
        await page.mouse.up()
        await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('proposal')
      }

      await page.keyboard.press('Meta+c')
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('proposal')
      await app.evaluate(({ Menu, BrowserWindow }) => {
        Menu.prototype.popup = function () { Object.assign(globalThis, { selectionContextMenu: this }) }
        BrowserWindow.getAllWindows()[0].webContents.on('context-menu', (_event, params) => {
          Object.assign(globalThis, { contextSelectionText: params.selectionText })
        })
      })
      const selected = await page.evaluate(() => {
        const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect()
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      })
      await page.mouse.click(selected.x, selected.y, { button: 'right' })
      await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'contextSelectionText'))).toBe('proposal')
      const copyLabel = await app.evaluate(() => Reflect.get(globalThis, 'selectionContextMenu').getMenuItemById('copy-selection').label)
      expect(copyLabel).toBe('复制')
      // Even if focus subsequently clears the selection, copy the menu snapshot.
      await page.evaluate(() => window.getSelection()?.removeAllRanges())
      await app.evaluate(({ clipboard }) => {
        clipboard.writeText('old clipboard')
        const item = Reflect.get(globalThis, 'selectionContextMenu').getMenuItemById('copy-selection')
        item.click()
      })
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('proposal')
      expect(session.errors).toEqual([])
    } finally { await app.close().catch(() => {}) }
  })
}

test('external selection uses optional context, a separate panel, and an explicit paste fallback', async () => {
  test.skip(process.platform !== 'darwin')
  const mock = await startMockLlm('stream', 5)
  const { app, page } = await launchApp('external-selection', {
    startupPdf: FIXTURE,
    executablePath: process.env.READING_TIME_TEST_PACKAGED
      ? resolve(ROOT, 'release/build.noindex/mac-arm64/阅读时光.app/Contents/MacOS/阅读时光') : undefined
  })
  try {
    expect((await page.evaluate(() => window.readingTime.external.status())).monitoring).toBe(false)
    // Replace only the OS permission and event source in this isolated Electron
    // process; UI, native window lifetime, IPC, translation and HTTP remain real.
    await app.evaluate(({ app, systemPreferences }) => {
      const modules = process.getBuiltinModule('node:module')
      const path = process.getBuiltinModule('node:path')
      const load = modules.createRequire(path.join(app.getAppPath(), 'package.json'))
      const file = load.resolve('./out/native/selection.node')
      const native = load(file) // Verify the real Node-API ABI, also inside a packaged app.
      if (!systemPreferences.isTrustedAccessibilityClient(false) && native.start(() => {}) !== false) {
        throw new Error('Mouse monitor started without accessibility authorization')
      }
      load.cache[file].exports = {
        start(fn: (json: string) => void) { Reflect.set(globalThis, 'gestureForTest', fn); return true },
        stop() { Reflect.deleteProperty(globalThis, 'gestureForTest') }
      }
      systemPreferences.isTrustedAccessibilityClient = () => false
    })
    await configureModel(page, mock.baseUrl, { apiKey: '' })
    await page.getByRole('button', { name: '打开设置' }).click()
    await page.getByRole('button', { name: '翻译偏好', exact: true }).click()
    await page.getByRole('switch', { name: /^跨应用划词翻译/ }).click()
    await expect(page.getByRole('button', { name: '授权 macOS 辅助功能' })).toBeVisible()
    await page.getByRole('button', { name: '保存设置' }).click()
    expect(await page.evaluate(() => window.readingTime.external.status())).toMatchObject({ trusted: false, monitoring: false })
    await app.evaluate(({ systemPreferences }) => { systemPreferences.isTrustedAccessibilityClient = () => true })
    await expect.poll(() => page.evaluate(async () => (await window.readingTime.external.status()).monitoring)).toBe(true)
    for (const context of [{ before: 'The fisherman stood on the river ', after: ' and cast his line.' }, null]) {
      const opened = app.waitForEvent('window')
      await app.evaluate((_electron, context) => Reflect.get(globalThis, 'gestureForTest')(JSON.stringify({
        type: 'selection', text: 'bank', x: 450, y: 350, ...context
      })), context)
      const panel = await opened
      await expect(panel.locator('.vocabulary-common')).toBeVisible()
      const payload = mock.requests.at(-1)!.body.messages as Array<{content: string}>
      expect(JSON.parse(payload[1].content)).toEqual({ selection: 'bank', context: context ? {
        before: context.before.trim(), after: context.after.trim()
      } : null })
      if (!context) await expect(panel.locator('.vocabulary-contextual')).toContainText('未提取到可用语境')
      expect(await panel.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(430)
      if (context) {
        const bounds = () => app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('#external-selection'))!
          return win.getBounds()
        })
        const before = await bounds()
        const grip = (await panel.getByRole('button', { name: '移动翻译窗口' }).boundingBox())!
        const x = grip.x + 30, y = grip.y + 10
        await panel.mouse.move(x, y)
        await panel.mouse.down()
        await panel.mouse.move(x + 60, y + 18)
        await panel.mouse.up()
        const moved = { x: before.x + 60, y: before.y + 18 }
        await expect.poll(bounds).toMatchObject(moved)
        await panel.getByRole('button', { name: '重新查询释义' }).click()
        await expect(panel.locator('.translation-status')).toContainText('词语释义完成')
        await expect.poll(bounds).toMatchObject(moved)
      }
      const closed = panel.waitForEvent('close')
      await app.evaluate(() => Reflect.get(globalThis, 'gestureForTest')('{"type":"dismiss"}'))
      await closed
    }
    const opened = app.waitForEvent('window')
    await app.evaluate(({ Menu }) => {
      const action = Menu.getApplicationMenu()!.items.flatMap(menu => menu.submenu?.items ?? []).find(item => item.label === '粘贴翻译…')!
      action.click()
    })
    const paste = await opened
    const count = mock.requests.length
    await expect(paste.getByLabel('粘贴要翻译的文字')).toHaveValue('')
    expect(mock.requests.length).toBe(count)
    await paste.getByLabel('粘贴要翻译的文字').fill('A complete sentence.')
    await paste.getByRole('button', { name: '翻译', exact: true }).click()
    await expect(paste.locator('.translation-text')).toContainText('跨越时间')
    const closed = paste.waitForEvent('close')
    await page.evaluate(() => window.readingTime.settings.save({ preferences: { externalSelection: false } }))
    await closed
    expect(await page.evaluate(() => window.readingTime.external.status())).toMatchObject({ monitoring: false, shortcut: false })
    expect(await app.evaluate(() => Reflect.has(globalThis, 'gestureForTest'))).toBe(false)
  } finally { await app.close(); await mock.close() }
})
