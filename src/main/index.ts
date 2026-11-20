import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, protocol, session, utilityProcess } from 'electron'
import type { MenuItemConstructorOptions, OpenDialogOptions } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LibraryStore } from './library-store'
import { SettingsStore } from './settings-store'
import { TranslationFeedback } from './translation-feedback'
import { LlmRequestError } from '../translation/errors'
import { TranslationRuntime } from '../translation/runtime'
import { ReleaseStore } from '../translation/releases'
import { MAX_CONTEXT_SIDE } from '../shared/lookup'
import {
  MAX_TRANSLATION_INPUT,
  type AppCommand,
  type ConnectionTestInput,
  type ImportResult,
  type LibraryEntry,
  type SaveSettingsInput,
  type TranslateInput,
  type TranslateResult
} from '../shared/types'

const APP_SCHEME = 'readingtime'
const APP_HOST = 'app'
const RENDERER_URL = `${APP_SCHEME}://${APP_HOST}/index.html`

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
])

if (process.env.READING_TIME_USER_DATA) {
  const override = resolve(process.env.READING_TIME_USER_DATA)
  mkdirSync(override, { recursive: true })
  app.setPath('userData', override)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let settingsStore: SettingsStore
let libraryStore: LibraryStore
let translationRuntime: TranslationRuntime
let translationFeedback: TranslationFeedback
let rendererReady = false
const pendingOpenPaths: string[] = []
const translationControllers = new Map<
  string,
  { controller: AbortController; senderId: number }
>()

function extractPdfPaths(args: string[]): string[] {
  return args.filter(
    (arg) => typeof arg === 'string' && arg.toLowerCase().endsWith('.pdf') && existsSync(arg)
  )
}

function sendCommand(command: AppCommand): void {
  const window = BrowserWindow.getFocusedWindow() || mainWindow
  if (window && !window.isDestroyed()) {
    window.webContents.send('app:command', command)
  }
}

function flushPendingPaths(): void {
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed()) return
  if (!pendingOpenPaths.length) return
  const paths = pendingOpenPaths.splice(0, pendingOpenPaths.length)
  mainWindow.webContents.send('app:command', {
    type: 'import-paths',
    paths
  } satisfies AppCommand)
}

function queueOpenPaths(paths: string[]): void {
  for (const path of extractPdfPaths(paths)) {
    if (!pendingOpenPaths.includes(path)) pendingOpenPaths.push(path)
  }
  flushPendingPaths()
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: '阅读时光',
          submenu: [
            { role: 'about', label: '关于阅读时光' },
            { type: 'separator' },
            {
              label: '设置…',
              accelerator: 'CmdOrCtrl+,',
              click: () => sendCommand({ type: 'settings' })
            },
            { type: 'separator' },
            { role: 'services', label: '服务' },
            { type: 'separator' },
            { role: 'hide', label: '隐藏阅读时光' },
            { role: 'hideOthers', label: '隐藏其他' },
            { role: 'unhide', label: '全部显示' },
            { type: 'separator' },
            { role: 'quit', label: '退出阅读时光' }
          ]
        }
      ]
    : []

  const fileSubmenu: MenuItemConstructorOptions[] = [
    {
      label: '导入 PDF…',
      accelerator: 'CmdOrCtrl+O',
      click: () => sendCommand({ type: 'import' })
    }
  ]
  if (!isMac) {
    fileSubmenu.push({
      label: '设置…',
      accelerator: 'CmdOrCtrl+,',
      click: () => sendCommand({ type: 'settings' })
    })
  }
  fileSubmenu.push(
    { type: 'separator' },
    isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }
  )
  const fileMenu: MenuItemConstructorOptions = {
    label: '文件',
    submenu: fileSubmenu
  }

  const editMenu: MenuItemConstructorOptions = {
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' }
    ]
  }

  const viewSubmenu: MenuItemConstructorOptions[] = []
  if (!app.isPackaged) {
    viewSubmenu.push(
      { role: 'reload', label: '重新载入' },
      { role: 'toggleDevTools', label: '开发者工具' },
      { type: 'separator' }
    )
  }
  viewSubmenu.push({ role: 'togglefullscreen', label: '进入全屏' })
  const viewMenu: MenuItemConstructorOptions = {
    label: '视图',
    submenu: viewSubmenu
  }

  const windowSubmenu: MenuItemConstructorOptions[] = [
    { role: 'minimize', label: '最小化' },
    { role: 'zoom', label: '缩放' }
  ]
  if (isMac) {
    windowSubmenu.push(
      { type: 'separator' },
      { role: 'front', label: '前置全部窗口' }
    )
  } else {
    windowSubmenu.push({ role: 'close', label: '关闭' })
  }
  const windowMenu: MenuItemConstructorOptions = {
    role: 'window',
    label: '窗口',
    submenu: windowSubmenu
  }

  const helpMenu: MenuItemConstructorOptions = {
    role: 'help',
    label: '帮助',
    submenu: [
      {
        label: '关于阅读时光',
        click: () => {
          void dialog.showMessageBox({
            type: 'info',
            title: '关于阅读时光',
            message: `阅读时光 ${app.getVersion()}`,
            detail:
              '一款以划词自动翻译为核心的本地 PDF 阅读器。\nPDF 与阅读记录只保存在你的电脑上；翻译时发送选中文字；词语释义还会发送附近的少量原文语境到你配置的模型服务。'
          })
        }
      }
    ]
  }

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    fileMenu,
    editMenu,
    viewMenu,
    windowMenu,
    helpMenu
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.host !== APP_HOST) {
        return new Response('Not found', { status: 404 })
      }
      let pathname: string
      try {
        pathname = decodeURIComponent(url.pathname)
      } catch {
        return new Response('Bad request', { status: 400 })
      }
      if (pathname === '/' || pathname === '') pathname = '/index.html'
      const rendererRoot = join(__dirname, '../renderer')
      const relativePath = normalize(pathname).replace(/^([/\\])+/, '')
      const filePath = join(rendererRoot, relativePath)
      if (filePath !== rendererRoot && !filePath.startsWith(rendererRoot + sep)) {
        return new Response('Forbidden', { status: 403 })
      }
      if (!existsSync(filePath)) {
        return new Response('Not found', { status: 404 })
      }
      return await net.fetch(pathToFileURL(filePath).toString())
    } catch (error) {
      console.error('[protocol] Failed to serve renderer asset.', error)
      return new Response('Internal error', { status: 500 })
    }
  })
}

function createWindow(): void {
  rendererReady = false
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1020,
    minHeight: 680,
    show: false,
    title: '阅读时光',
    backgroundColor: settingsStore.get().preferences.readerTone === 'night' ? '#14120e' : '#f8f9fa',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 18 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true
    }
  })
  mainWindow = window

  window.once('ready-to-show', () => {
    window.show()
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = []
    if (params.isEditable) {
      items.push(
        { role: 'undo', label: '撤销', enabled: params.editFlags.canUndo },
        { role: 'redo', label: '重做', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', label: '剪切', enabled: params.editFlags.canCut }
      )
    }
    if (params.selectionText && params.editFlags.canCopy) {
      // Snapshot the selection: opening the native menu or a translation popup
      // must not cause us to copy some later selection instead.
      const selectedText = params.selectionText
      items.push({
        id: 'copy-selection', label: '复制', accelerator: 'CmdOrCtrl+C',
        click: () => clipboard.writeText(selectedText)
      })
    }
    if (params.isEditable) {
      items.push(
        { role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', label: '全选', enabled: params.editFlags.canSelectAll }
      )
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window })
  })
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (url !== current) event.preventDefault()
  })

  window.webContents.on('did-start-loading', () => {
    rendererReady = false
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[window] Renderer process exited.', details.reason)
  })

  window.on('closed', () => {
    rendererReady = false
    mainWindow = null
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadURL(RENDERER_URL)
  }
}

function registerIpc(): void {
  ipcMain.handle('app:ready', (event) => {
    if (event.sender !== mainWindow?.webContents) return
    rendererReady = true
    flushPendingPaths()
  })
  ipcMain.handle('library:list', (): LibraryEntry[] => libraryStore.list())

  ipcMain.handle('library:import-dialog', async (event): Promise<ImportResult> => {
    const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow
    const options: OpenDialogOptions = {
      title: '导入 PDF',
      buttonLabel: '导入',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
    }
    const selection = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (selection.canceled || selection.filePaths.length === 0) {
      return { canceled: true, imported: [], duplicates: [], failed: [] }
    }
    return libraryStore.importPaths(selection.filePaths)
  })

  ipcMain.handle('library:import-paths', async (_event, paths: unknown): Promise<ImportResult> => {
    if (!Array.isArray(paths)) {
      return {
        canceled: false,
        imported: [],
        duplicates: [],
        failed: [{ name: '导入', error: '无效的文件列表。' }]
      }
    }
    return libraryStore.importPaths(paths as string[])
  })

  ipcMain.handle('library:read', async (_event, id: unknown): Promise<Uint8Array> => {
    if (typeof id !== 'string') throw new Error('无效的文档 ID。')
    const buffer = await libraryStore.read(id)
    return new Uint8Array(buffer)
  })

  ipcMain.handle(
    'library:update',
    (
      _event,
      id: unknown,
      patch: unknown
    ): LibraryEntry | null => {
      if (typeof id !== 'string' || typeof patch !== 'object' || patch === null) return null
      return libraryStore.update(id, patch)
    }
  )

  ipcMain.handle('library:remove', async (_event, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: '无效的文档 ID。' }
    return libraryStore.remove(id)
  })

  ipcMain.handle('settings:get', () => settingsStore.get())

  ipcMain.handle('settings:save', (_event, input: SaveSettingsInput) => {
    if (typeof input !== 'object' || input === null) {
      return { ok: false, error: '无效的设置内容。' }
    }
    const result = settingsStore.save(input)
    if (result.ok) syncNativeTheme()
    return result
  })

  ipcMain.handle('settings:test-connection', async (_event, input: ConnectionTestInput) => {
    const { baseUrl, modelId, apiKey } = settingsStore.getConnectionInput({
      baseUrl: typeof input?.baseUrl === 'string' ? input.baseUrl : '',
      clearApiKey: input?.clearApiKey === true,
      modelId: typeof input?.modelId === 'string' ? input.modelId : '',
      apiKey: typeof input?.apiKey === 'string' ? input.apiKey : undefined
    })
    return translationRuntime.testConnection({ baseUrl, modelId, apiKey })
  })

  ipcMain.handle('translate:start', async (event, input: TranslateInput): Promise<TranslateResult> => {
    if (
      typeof input !== 'object' ||
      input === null ||
      typeof input.requestId !== 'string' ||
      !input.requestId ||
      input.requestId.length > 128
    ) {
      return {
        ok: false,
        error: { message: '无效的翻译请求。', code: 'bad_request' }
      }
    }
    if (typeof input.text !== 'string' || !input.text.trim()) {
      return {
        ok: false,
        error: { message: '请先选中需要翻译的文字。', code: 'bad_request' }
      }
    }
    if (input.text.length > MAX_TRANSLATION_INPUT) {
      return {
        ok: false,
        error: {
          message: `一次最多翻译 ${MAX_TRANSLATION_INPUT} 个字符，请缩短选区。`,
          code: 'bad_request'
        }
      }
    }

    if (input.mode !== undefined && input.mode !== 'lookup' && input.mode !== 'translation') {
      return { ok: false, error: { message: '无效的翻译模式。', code: 'bad_request' } }
    }
    if (input.context !== undefined && (
      !input.context || typeof input.context.before !== 'string' || typeof input.context.after !== 'string' ||
      input.context.before.length > MAX_CONTEXT_SIDE || input.context.after.length > MAX_CONTEXT_SIDE
    )) {
      return { ok: false, error: { message: '无效的选区语境。', code: 'bad_request' } }
    }

    const settings = settingsStore.get()
    if (!settings.llm.baseUrl || !settings.llm.modelId) {
      return {
        ok: false,
        error: {
          message: '还没有配置翻译模型，请先填写 Base URL 和模型 ID。',
          code: 'not_configured'
        }
      }
    }

    if (translationControllers.has(input.requestId)) return { ok: false, error: { code: 'bad_request', message: '翻译请求 ID 重复。' } }
    const controller = new AbortController()
    translationControllers.set(input.requestId, {
      controller,
      senderId: event.sender.id
    })
    const onDestroyed = (): void => controller.abort()
    event.sender.once('destroyed', onDestroyed)

    const targetLanguage = input.targetLanguage?.toString().trim().slice(0, 50) || settings.llm.targetLanguage
    let accumulated = ''

    try {
      const result = await translationRuntime.translate(
        { ...input, targetLanguage },
        { baseUrl: settings.llm.baseUrl, modelId: settings.llm.modelId, apiKey: settingsStore.getApiKey() },
        (delta) => {
          accumulated += delta
          if (!event.sender.isDestroyed()) event.sender.send('translate:delta', { requestId: input.requestId, delta })
        },
        controller.signal
      )
      if (!result.ok && accumulated && !result.cancelled) result.text = accumulated
      if (result.ok && result.text && result.mode && !event.sender.isDestroyed()) {
        result.feedbackId = translationFeedback.remember(event.sender, {
          appVersion: app.getVersion(),
          source: input.text,
          text: result.text,
          targetLanguage,
          modelId: settings.llm.modelId,
          mode: result.mode,
          context: input.context && { before: input.context.before, after: input.context.after },
          runtimeId: result.runtimeId,
          runtimeVersion: result.runtimeVersion,
          strategyVersion: result.strategyVersion
        })
      }
      return result
    } catch (error) {
      const normalized =
        error instanceof LlmRequestError
          ? error
          : new LlmRequestError(
              error instanceof Error ? error.message : '翻译失败，请稍后重试。',
              'unknown'
            )
      const result: TranslateResult = {
        ok: false,
        error: { message: normalized.message, code: normalized.code },
        cancelled: normalized.code === 'cancelled'
      }
      if (accumulated && normalized.code !== 'cancelled') {
        result.text = accumulated
      }
      return result
    } finally {
      translationControllers.delete(input.requestId)
      if (!event.sender.isDestroyed()) {
        event.sender.removeListener('destroyed', onDestroyed)
      }
    }
  })

  ipcMain.handle('translate:cancel', (_event, requestId: unknown) => {
    if (typeof requestId !== 'string') return
    const active = translationControllers.get(requestId)
    if (active?.senderId === _event.sender.id) active.controller.abort()
  })

  ipcMain.handle('translation-runtime:status', () => translationRuntime.status())
  ipcMain.handle('translate:feedback', (event, id, vote, reason) =>
    translationFeedback.save(event.sender, id, vote, reason))
  ipcMain.handle('translation-runtime:rollback', () => translationRuntime.rollback())
  ipcMain.handle('translation-runtime:restore', () => translationRuntime.restoreBuiltin())
  ipcMain.handle('translation-runtime:import', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow
    const options: OpenDialogOptions = { title: '导入翻译策略或更新包', buttonLabel: '导入',
      properties: ['openFile'], filters: [{ name: '翻译策略或 manifest.json', extensions: ['json'] }] }
    const selection = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    if (selection.canceled || !selection.filePaths.length) return { ok: false, canceled: true, status: translationRuntime.status() }
    return translationRuntime.install(selection.filePaths[0])
  })

  ipcMain.handle('app:get-version', () => app.getVersion())
  ipcMain.handle('app:copy-text', (_event, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })
}

function wireAppLifecycle(): void {
  app.on('second-instance', (_event, commandLine) => {
    if (!mainWindow && app.isReady()) createWindow()
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    queueOpenPaths(commandLine.slice(1))
  })

  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    if (!mainWindow && app.isReady()) createWindow()
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
    queueOpenPaths([filePath])
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    for (const { controller } of translationControllers.values()) controller.abort()
    translationControllers.clear()
    translationRuntime?.close()
  })
}

function syncNativeTheme(): void {
  nativeTheme.themeSource = settingsStore.get().preferences.readerTone === 'night' ? 'dark' : 'light'
}

if (hasSingleInstanceLock) {
  wireAppLifecycle()

  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && !app.isPackaged) {
      const devIcon = join(process.cwd(), 'build', 'icon.png')
      if (existsSync(devIcon)) app.dock?.setIcon(devIcon)
    }
    settingsStore = new SettingsStore(app.getPath('userData'))
    translationFeedback = new TranslationFeedback(app.getPath('userData'))
    syncNativeTheme()
    libraryStore = new LibraryStore(app.getPath('userData'))
    translationRuntime = new TranslationRuntime(
      new ReleaseStore(app.getPath('userData'), join(__dirname, 'translation-engine.js')),
      () => utilityProcess.fork(join(__dirname, 'translation-worker.js'), [], {
        serviceName: 'ReadingTime Translation', stdio: 'ignore',
        // Do not inherit unrelated credentials from the shell environment.
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
          ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT'].includes(key)))
      })
    )
    // Translation failure must not prevent the local reader from opening.
    try { await translationRuntime.initialize() }
    catch { console.error('[translation] Translation worker could not start; reading remains available.') }

    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })
    session.defaultSession.setPermissionCheckHandler(() => false)

    registerIpc()
    registerProtocol()
    buildMenu()
    createWindow()

    const initialPaths = extractPdfPaths(process.argv.slice(1))
    if (initialPaths.length) queueOpenPaths(initialPaths)
  }).catch((error) => {
    console.error('[app] Failed to initialize.', error)
    dialog.showErrorBox(
      '阅读时光无法启动',
      error instanceof Error ? error.message : '初始化应用时发生未知错误。'
    )
    app.quit()
  })
}
