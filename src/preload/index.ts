import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppCommand,
  AppSettings,
  ConnectionTestInput,
  ImportResult,
  LibraryEntry,
  ReadingTimeApi,
  SaveSettingsInput,
  TranslateInput,
  TranslationDelta
} from '../shared/types'

const api: ReadingTimeApi = {
  library: {
    list: () => ipcRenderer.invoke('library:list') as Promise<LibraryEntry[]>,
    importDialog: () => ipcRenderer.invoke('library:import-dialog') as Promise<ImportResult>,
    importPaths: (paths) =>
      ipcRenderer.invoke('library:import-paths', paths) as Promise<ImportResult>,
    read: (id) => ipcRenderer.invoke('library:read', id) as Promise<Uint8Array>,
    update: (id, patch) =>
      ipcRenderer.invoke('library:update', id, patch) as Promise<LibraryEntry | null>,
    remove: (id) => ipcRenderer.invoke('library:remove', id)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
    save: (input: SaveSettingsInput) => ipcRenderer.invoke('settings:save', input),
    testConnection: (input: ConnectionTestInput) =>
      ipcRenderer.invoke('settings:test-connection', input)
  },
  translate: {
    start: (input: TranslateInput) => ipcRenderer.invoke('translate:start', input),
    cancel: (requestId: string) => ipcRenderer.invoke('translate:cancel', requestId),
    onDelta: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: TranslationDelta): void => {
        callback(payload)
      }
      ipcRenderer.on('translate:delta', listener)
      return () => ipcRenderer.removeListener('translate:delta', listener)
    }
  },
  translationRuntime: {
    status: () => ipcRenderer.invoke('translation-runtime:status'),
    importUpdate: () => ipcRenderer.invoke('translation-runtime:import'),
    rollback: () => ipcRenderer.invoke('translation-runtime:rollback'),
    restoreBuiltin: () => ipcRenderer.invoke('translation-runtime:restore')
  },
  app: {
    ready: () => ipcRenderer.invoke('app:ready'),
    getVersion: () => ipcRenderer.invoke('app:get-version') as Promise<string>,
    copyText: (text: string) => ipcRenderer.invoke('app:copy-text', text),
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    onCommand: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, command: AppCommand): void => {
        callback(command)
      }
      ipcRenderer.on('app:command', listener)
      return () => ipcRenderer.removeListener('app:command', listener)
    }
  }
}

contextBridge.exposeInMainWorld('readingTime', api)
