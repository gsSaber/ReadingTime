import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
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
  opts: { startupPdf?: string; reuseProfile?: boolean } = {}
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
  const app = await electron.launch({ args, cwd: ROOT, env })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForSelector('.app-frame')
  return { app, page, profile, errors }
}

async function configureModel(
  page: Page,
  baseUrl: string,
  options: { expectConnection?: 'success' | 'error' } = {}
): Promise<void> {
  await page.getByRole('button', { name: '打开设置' }).click()
  await expect(page.locator('.settings-modal')).toBeVisible()
  const baseInput = page.locator('input[placeholder="https://api.openai.com/v1"]')
  await expect(baseInput).toBeVisible()
  await baseInput.fill(baseUrl)
  await page.locator('input[placeholder="例如 gpt-4o-mini"]').fill('mock-translator')
  await page.locator('input[placeholder*="无需鉴权"]').fill('test-key-123')
  await expect(page.getByRole('button', { name: '保存设置' })).toBeInViewport()
  await page.getByRole('button', { name: '测试连接' }).click()
  await expect(page.locator('.test-result')).toContainText(
    options.expectConnection === 'error' ? '认证失败' : '连接成功'
  )
  await page.getByRole('button', { name: '保存设置' }).click()
  await expect(page.locator('.settings-modal')).toHaveCount(0)
}

async function selectVisibleText(page: Page, lineOffset = 0): Promise<void> {
  const coords = await page.evaluate((offset: number) => {
    const viewportHeight = window.innerHeight
    const rows: Array<{ rect: { top: number; bottom: number; left: number; right: number; height: number }; text: string }> = []
    for (const span of document.querySelectorAll<HTMLElement>('.pdf-text-layer span')) {
      if (span.firstChild?.nodeType !== Node.TEXT_NODE) continue
      const rect = span.getBoundingClientRect()
      if (rect.top <= 140 || rect.bottom >= viewportHeight - 180 || rect.height <= 5) continue
      const last = rows.at(-1)
      if (last && Math.abs(last.rect.top - rect.top) < 2) {
        last.rect.left = Math.min(last.rect.left, rect.left)
        last.rect.right = Math.max(last.rect.right, rect.right)
        last.text += span.textContent
      } else rows.push({ rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height }, text: span.textContent || '' })
    }
    const spans = rows.filter(row => row.text.trim().length > 12)
    if (spans.length < 2) return null
    const start = spans[Math.min(offset, spans.length - 2)]
    const end = spans[Math.min(offset + 1, spans.length - 1)]
    return {
      x1: start.rect.left + 8,
      y1: start.rect.top + start.rect.height * 0.55,
      x2: Math.min(end.rect.right - 8, start.rect.right - 8),
      y2: end.rect.top + end.rect.height * 0.55
    }
  }, lineOffset)
  if (!coords) throw new Error('No selectable PDF text was found.')
  await page.mouse.move(coords.x1, coords.y1)
  await page.mouse.down()
  await page.mouse.move(coords.x2, coords.y2, { steps: 16 })
  await page.mouse.up()
}

async function selectPdfTerm(page: Page, term: string, within: string): Promise<void> {
  const coords = await page.evaluate(({ term, within }) => {
    const layer = [...document.querySelectorAll<HTMLElement>('.pdf-text-layer')]
      .find((element) => element.textContent?.includes(within))
    if (!layer) throw new Error(`No PDF text contains ${within}`)
    const index = layer.textContent!.indexOf(term, layer.textContent!.indexOf(within))
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

    await selectVisibleText(page, 0)
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
    await page.getByRole('button', { name: '关闭翻译' }).click()
    await expect(page.locator('.translation-popup')).toHaveCount(0)

    await page.getByRole('button', { name: 'PDF 目录' }).click()
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

    await selectVisibleText(page, 0)
    await expect(page.locator('.translation-popup')).toBeVisible()
    await expect(page.locator('.translation-error')).toContainText('还没有配置翻译模型')
    await expect(page.getByRole('button', { name: /打开模型设置/ })).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: resolve(ARTIFACTS, 'translation-not-configured.png') })

    await page.getByRole('button', { name: '关闭翻译' }).click()
    await configureModel(page, mock.baseUrl, { expectConnection: 'error' })
    await selectVisibleText(page, 1)
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
    executablePath: resolve(ROOT, 'release/mac-arm64/阅读时光.app/Contents/MacOS/阅读时光'),
    args: [FIXTURE], cwd: ROOT, env
  })
  try {
    const page = await app.firstWindow()
    const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))
    expect(identity.packaged).toBe(true)
    expect(identity.version).toBe(JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version)
    const bundleId = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', resolve(ROOT, 'release/mac-arm64/阅读时光.app/Contents/Info.plist')], { encoding: 'utf8' }).trim()
    expect(bundleId).toBe('com.readingtime.reader')
    await expect(page.locator('.toolbar-doc h1')).toHaveText('quiet-reading')
    await page.waitForSelector('.pdf-page-content.is-rendered')
    await page.getByRole('button', { name: /^阅读主题：/ }).click()
    await expect(page.locator('html')).toHaveAttribute('data-reader-tone', 'sepia')
    await expect(page.getByRole('separator', { name: '调整书架宽度' })).toBeVisible()
    await page.getByRole('scrollbar', { name: 'PDF 阅读滚动条' }).focus()
    await page.keyboard.press('End')
    await expect(page.locator('.page-number input')).toHaveValue('3')
  } finally {
    await app.close().catch(() => {})
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
    await selectVisibleText(page)
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
    await page.locator('.vocabulary-context-source summary').click()
    await expect(page.locator('.vocabulary-context-source blockquote')).toContainText('Reading is not a race')
    await expect(page.locator('.vocabulary-context-source mark')).toHaveText('Reading')
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
    await page.getByRole('button', { name: '关闭翻译' }).click()
    await selectPdfTerm(page, 'Reading', 'The Quiet Art of Reading')
    await expect(page.locator('.vocabulary-common')).toBeVisible()
    expect(lookupRequests().length).toBe(count + 1)
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
