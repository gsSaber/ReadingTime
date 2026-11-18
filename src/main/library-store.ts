import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { chmod, copyFile, readFile, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { ImportResult, LibraryEntry } from '../shared/types'

const MAX_PDF_SIZE = 500 * 1024 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface StoredLibraryEntry extends LibraryEntry {
  hash: string
}

interface StoredIndex {
  version: 1
  entries: StoredLibraryEntry[]
}

function emptyIndex(): StoredIndex {
  return { version: 1, entries: [] }
}

function cleanTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, 180) || '未命名文档'
}

export function titleFromPath(filePath: string): string {
  const raw = basename(filePath, extname(filePath))
  return cleanTitle(raw.replace(/[_]+/g, ' '))
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function toPublicEntry(entry: StoredLibraryEntry): LibraryEntry {
  return {
    id: entry.id,
    title: entry.title,
    size: entry.size,
    pageCount: entry.pageCount,
    lastPage: entry.lastPage,
    addedAt: entry.addedAt,
    openedAt: entry.openedAt
  }
}

function sortEntries(entries: StoredLibraryEntry[]): StoredLibraryEntry[] {
  return [...entries].sort(
    (a, b) => Math.max(b.openedAt, b.addedAt) - Math.max(a.openedAt, a.addedAt)
  )
}

function sanitizeEntry(value: unknown): StoredLibraryEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const input = value as Record<string, unknown>
  if (typeof input.id !== 'string' || !UUID_PATTERN.test(input.id)) return null
  if (typeof input.hash !== 'string' || input.hash.length < 16) return null
  if (typeof input.title !== 'string') return null
  const pageCount =
    typeof input.pageCount === 'number' && Number.isFinite(input.pageCount)
      ? Math.max(0, Math.min(100000, Math.floor(input.pageCount)))
      : 0
  const lastPage =
    typeof input.lastPage === 'number' && Number.isFinite(input.lastPage)
      ? Math.max(1, Math.min(pageCount || 100000, Math.floor(input.lastPage)))
      : 1
  return {
    id: input.id,
    hash: input.hash,
    title: cleanTitle(input.title),
    size:
      typeof input.size === 'number' && Number.isFinite(input.size)
        ? Math.max(0, Math.floor(input.size))
        : 0,
    pageCount,
    lastPage,
    addedAt:
      typeof input.addedAt === 'number' && Number.isFinite(input.addedAt)
        ? input.addedAt
        : Date.now(),
    openedAt:
      typeof input.openedAt === 'number' && Number.isFinite(input.openedAt)
        ? input.openedAt
        : 0
  }
}

function friendlyFileError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = String((error as NodeJS.ErrnoException).code)
    if (code === 'ENOENT') return '文件不存在或已被移动。'
    if (code === 'EACCES' || code === 'EPERM') return '没有读取该文件的权限。'
    if (code === 'ENOSPC') return '磁盘空间不足。'
    if (code === 'EISDIR') return '请选择 PDF 文件，而不是文件夹。'
  }
  return error instanceof Error ? error.message : '导入失败。'
}

export class LibraryStore {
  private readonly libraryDir: string
  private readonly indexPath: string
  private entries: StoredLibraryEntry[]

  constructor(userDataPath: string) {
    this.libraryDir = join(userDataPath, 'library')
    mkdirSync(this.libraryDir, { recursive: true })
    const dataDir = join(userDataPath, 'data')
    mkdirSync(dataDir, { recursive: true })
    this.indexPath = join(dataDir, 'library.json')
    this.entries = this.load()
  }

  private load(): StoredLibraryEntry[] {
    if (!existsSync(this.indexPath)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) as unknown
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !Array.isArray((parsed as { entries?: unknown }).entries)
      ) {
        return []
      }
      return ((parsed as { entries: unknown[] }).entries)
        .map(sanitizeEntry)
        .filter((entry): entry is StoredLibraryEntry => entry !== null)
    } catch (error) {
      console.error('[library] Failed to load library index.', error)
      try {
        renameSync(this.indexPath, `${this.indexPath}.corrupt-${Date.now()}`)
      } catch {
        // Ignore: a fresh index will be created on the next write.
      }
      return []
    }
  }

  private persist(): void {
    const temporaryPath = `${this.indexPath}.tmp`
    const index: StoredIndex = { version: 1, entries: this.entries }
    writeFileSync(temporaryPath, JSON.stringify(index, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    })
    renameSync(temporaryPath, this.indexPath)
  }

  list(): LibraryEntry[] {
    return sortEntries(this.entries).map(toPublicEntry)
  }

  private find(id: string): StoredLibraryEntry | undefined {
    return this.entries.find((entry) => entry.id === id)
  }

  private pdfPath(id: string): string {
    return join(this.libraryDir, `${id}.pdf`)
  }

  async importPaths(paths: string[]): Promise<ImportResult> {
    const result: ImportResult = {
      canceled: false,
      imported: [],
      duplicates: [],
      existing: [],
      failed: []
    }
    const uniquePaths = Array.from(
      new Set(
        (Array.isArray(paths) ? paths : [])
          .filter((path): path is string => typeof path === 'string')
          .map((path) => path.trim())
          .filter(Boolean)
      )
    ).slice(0, 100)

    for (const sourcePath of uniquePaths) {
      const name = basename(sourcePath)
      try {
        if (extname(sourcePath).toLowerCase() !== '.pdf') {
          result.failed.push({ name, error: '仅支持 PDF 文件。' })
          continue
        }
        const info = await stat(sourcePath).catch(() => null)
        if (!info || !info.isFile()) {
          result.failed.push({ name, error: '文件不存在或不是有效文件。' })
          continue
        }
        if (info.size <= 0) {
          result.failed.push({ name, error: '文件为空。' })
          continue
        }
        if (info.size > MAX_PDF_SIZE) {
          result.failed.push({ name, error: '文件超过 500 MB，暂不支持导入。' })
          continue
        }

        const hash = await hashFile(sourcePath)
        const existing = this.entries.find((entry) => entry.hash === hash)
        if (existing) {
          result.duplicates.push(existing.title)
          result.existing!.push(toPublicEntry(existing))
          continue
        }

        const id = randomUUID()
        const storagePath = this.pdfPath(id)
        const temporaryPath = `${storagePath}.importing`
        await copyFile(sourcePath, temporaryPath)
        await chmod(temporaryPath, 0o600)
        renameSync(temporaryPath, storagePath)

        const now = Date.now()
        const entry: StoredLibraryEntry = {
          id,
          hash,
          title: titleFromPath(sourcePath),
          size: info.size,
          pageCount: 0,
          lastPage: 1,
          addedAt: now,
          openedAt: 0
        }
        this.entries.push(entry)
        try {
          this.persist()
        } catch (error) {
          this.entries = this.entries.filter((candidate) => candidate.id !== id)
          await rm(storagePath, { force: true })
          throw error
        }
        result.imported.push(toPublicEntry(entry))
      } catch (error) {
        result.failed.push({ name, error: friendlyFileError(error) })
      }
    }

    return result
  }

  async read(id: string): Promise<Buffer> {
    const entry = this.find(id)
    if (!entry) throw new Error('文档不在资料库中。')
    const filePath = this.pdfPath(id)
    if (!existsSync(filePath)) throw new Error('PDF 文件已丢失，请重新导入。')
    const buffer = await readFile(filePath)
    if (buffer.length === 0) throw new Error('PDF 文件为空。')
    entry.openedAt = Date.now()
    try {
      this.persist()
    } catch (error) {
      console.error('[library] Failed to update opened time.', error)
    }
    return buffer
  }

  update(
    id: string,
    patch: Partial<Pick<LibraryEntry, 'title' | 'lastPage' | 'pageCount'>>
  ): LibraryEntry | null {
    const entry = this.find(id)
    if (!entry) return null

    if (typeof patch.pageCount === 'number' && Number.isFinite(patch.pageCount)) {
      entry.pageCount = Math.max(0, Math.min(100000, Math.floor(patch.pageCount)))
    }
    if (typeof patch.lastPage === 'number' && Number.isFinite(patch.lastPage)) {
      entry.lastPage = Math.max(1, Math.floor(patch.lastPage))
    }
    if (entry.pageCount > 0 && entry.lastPage > entry.pageCount) {
      entry.lastPage = entry.pageCount
    }
    if (typeof patch.title === 'string') {
      const title = cleanTitle(patch.title)
      if (title) entry.title = title
    }

    this.persist()
    return toPublicEntry(entry)
  }

  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.find(id)
    if (!entry) return { ok: false, error: '文档不存在。' }
    const filePath = this.pdfPath(id)
    try {
      unlinkSync(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { ok: false, error: friendlyFileError(error) }
      }
    }
    this.entries = this.entries.filter((candidate) => candidate.id !== id)
    this.persist()
    return { ok: true }
  }

}
