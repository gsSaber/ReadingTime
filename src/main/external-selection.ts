import { BrowserWindow, globalShortcut, screen, systemPreferences } from 'electron'
import { join } from 'node:path'
import { contextAroundSelection } from '../shared/lookup'
import { MAX_SELECTION_LENGTH, type ExternalSelection, type ExternalStatus } from '../shared/types'

const shortcut = 'Command+Alt+T'

interface NativeMonitor {
  start: (receive: (json: string) => void) => boolean
  stop: () => void
}

interface Gesture {
  type: 'selection' | 'dismiss'
  text?: string
  before?: string
  after?: string
  x?: number
  y?: number
}

export class ExternalSelections {
  private enabled = false
  private monitor?: NativeMonitor
  private monitoring = false
  private registered = false
  private error?: string
  private timer?: NodeJS.Timeout
  private epoch = 0
  private panel?: BrowserWindow
  private seed: ExternalSelection | null = null
  private anchor?: Electron.Point
  private url: string

  constructor(url: string) { this.url = url }

  configure(enabled: boolean): void {
    if (process.platform !== 'darwin' || enabled === this.enabled) return
    this.enabled = enabled
    if (!enabled) {
      if (this.registered) globalShortcut.unregister(shortcut)
      this.registered = false
      clearInterval(this.timer)
      this.stopMonitoring()
      this.close()
      return
    }
    this.registered = globalShortcut.register(shortcut, () => this.paste())
    this.refresh()
    this.timer = setInterval(() => this.refresh(), 2500)
    this.timer.unref()
  }

  private stopMonitoring(): void {
    this.epoch++
    this.monitor?.stop()
    this.monitoring = false
    this.error = undefined
  }

  private refresh(): void {
    const trusted = systemPreferences.isTrustedAccessibilityClient(false)
    if (!trusted && this.monitoring) {
      this.stopMonitoring()
      this.close()
    }
    if (!trusted || this.monitoring || !this.enabled) return
    try {
      this.monitor ??= require(join(__dirname, '../native/selection.node')) as NativeMonitor
      const epoch = ++this.epoch
      this.monitoring = this.monitor.start(json => {
        if (!this.enabled || epoch !== this.epoch) return
        const event: Gesture = JSON.parse(json)
        if (event.type === 'dismiss') { this.close(); return }
        if (!event.text?.trim() || event.text.length > MAX_SELECTION_LENGTH) return
        const item: ExternalSelection = { text: event.text }
        if (typeof event.before === 'string' && typeof event.after === 'string') {
          const excerpt = event.before + event.text + event.after
          item.context = contextAroundSelection(excerpt, event.before.length, event.before.length + event.text.length)
        }
        this.open(item, { x: Math.round(event.x!), y: Math.round(event.y!) })
      })
      this.error = this.monitoring ? undefined : '无法监听划词，请检查辅助功能权限。'
    } catch {
      this.error = '跨应用选区组件加载失败，请使用粘贴翻译。'
    }
  }

  status(prompt = false): ExternalStatus {
    const supported = process.platform === 'darwin'
    const trusted = supported && systemPreferences.isTrustedAccessibilityClient(prompt)
    return { supported, trusted, monitoring: this.monitoring, shortcut: this.registered, error: this.error }
  }

  paste(): void {
    if (this.enabled) this.open(null, screen.getCursorScreenPoint())
  }

  private open(seed: ExternalSelection | null, anchor: Electron.Point): void {
    this.close()
    const area = screen.getDisplayNearestPoint(anchor).workArea
    const win = new BrowserWindow({
      title: '跨应用翻译', type: 'panel', frame: false, resizable: false, fullscreenable: false,
      alwaysOnTop: true, show: false, skipTaskbar: true, acceptFirstMouse: true,
      width: Math.min(430, area.width), height: 225,
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true,
        contextIsolation: true, nodeIntegration: false }
    })
    this.panel = win
    this.anchor = anchor
    this.seed = seed
    this.resize(win.webContents, 225)
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.once('ready-to-show', () => {
      if (this.panel !== win) return
      if (seed) win.showInactive()
      else { win.show(); win.focus() }
    })
    win.on('blur', () => { if (this.panel === win) this.close() })
    win.on('closed', () => {
      if (this.panel === win) { this.panel = undefined; this.seed = null }
    })
    void win.loadURL(this.url + '#external-selection').catch(() => { if (this.panel === win) this.close() })
  }

  owns(sender: Electron.WebContents): boolean { return this.panel?.webContents === sender }
  initial(sender: Electron.WebContents): ExternalSelection | null { return this.owns(sender) ? this.seed : null }

  move(sender: Electron.WebContents, x: number, y: number): void {
    const win = this.panel
    if (!win || !this.owns(sender) || !Number.isFinite(x) || !Number.isFinite(y)) return
    const [width, height] = win.getSize()
    const target = { x: Math.round(x), y: Math.round(y), width, height }
    const area = screen.getDisplayMatching(target).workArea
    // Future content resizes should follow the moved panel, not the original selection.
    this.anchor = undefined
    win.setPosition(
      Math.max(area.x, Math.min(target.x, area.x + area.width - width)),
      Math.max(area.y, Math.min(target.y, area.y + area.height - height))
    )
  }

  resize(sender: Electron.WebContents, height: number): void {
    const win = this.panel
    if (!win || !this.owns(sender) || !Number.isFinite(height)) return
    const point = this.anchor
    const current = win.getBounds()
    const area = (point ? screen.getDisplayNearestPoint(point) : screen.getDisplayMatching(current)).workArea
    const w = Math.min(430, area.width)
    const h = Math.min(area.height, 520, Math.max(100, Math.ceil(height)))
    const x = Math.max(area.x, Math.min(point?.x ?? current.x, area.x + area.width - w))
    let top = current.y
    if (point) {
      const below = point.y + 12
      top = below + h <= area.y + area.height ? below : point.y - 12 - h
    }
    const y = Math.max(area.y, Math.min(top, area.y + area.height - h))
    win.setBounds({ x, y, width: w, height: h })
  }

  close(): void {
    const window = this.panel
    this.panel = undefined
    this.seed = null
    window?.destroy()
  }
}
