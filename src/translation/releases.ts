import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_STRATEGY, parseStrategy, type TranslationStrategy } from './strategy.ts'

export interface Release { id: string; version: string; strategy: TranslationStrategy; enginePath: string }
export interface ReleaseState { active: string; previous: string | null }
export interface UpdateManifest {
  format: 'readingtime-translation-update'
  protocolVersion: 1
  version: string
  strategySha256: string
  engineSha256?: string
}
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const regularFile = (path: string, limit: number): Buffer => {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('更新文件无效、过大或使用了符号链接。')
  return readFileSync(path)
}

export class ReleaseStore {
  readonly root: string
  readonly builtin: Release
  constructor(userDataPath: string, enginePath: string) {
    this.root = join(userDataPath, 'translation-runtime')
    mkdirSync(join(this.root, 'versions'), { recursive: true })
    this.builtin = { id: 'builtin', version: 'builtin', strategy: parseStrategy(DEFAULT_STRATEGY), enginePath }
  }

  readState(): ReleaseState {
    const path = join(this.root, 'active.json')
    if (!existsSync(path)) return { active: 'builtin', previous: null }
    const state = JSON.parse(readFileSync(path, 'utf8')) as ReleaseState
    if (!this.validId(state.active) || state.previous !== null && !this.validId(state.previous)) throw new Error('翻译版本记录已损坏。')
    return state
  }

  saveState(state: ReleaseState): void {
    const path = join(this.root, 'active.json')
    writeFileSync(path + '.tmp', JSON.stringify(state), { mode: 0o600 })
    renameSync(path + '.tmp', path)
  }

  private validId(id: unknown): id is string { return id === 'builtin' || typeof id === 'string' && /^[a-f0-9]{64}$/.test(id) }

  get(id: string): Release {
    if (id === 'builtin') return this.builtin
    if (!this.validId(id)) throw new Error('无效的翻译版本。')
    const dir = join(this.root, 'versions', id)
    if (lstatSync(dir).isSymbolicLink()) throw new Error('版本目录不能是符号链接。')
    const data = this.readPackage(join(dir, 'manifest.json'))
    if (data.id !== id) throw new Error('翻译更新包校验失败。')
    return { id, version: data.manifest.version, strategy: data.strategy, enginePath: data.engine ? join(dir, 'engine.cjs') : this.builtin.enginePath }
  }

  private readPackage(path: string): { manifest: UpdateManifest; strategy: TranslationStrategy; engine?: Buffer; id: string; policy: Buffer } {
    const manifest = JSON.parse(regularFile(path, 32000).toString()) as UpdateManifest
    if (manifest.format !== 'readingtime-translation-update' || manifest.protocolVersion !== 1 ||
      typeof manifest.version !== 'string' || !manifest.version.trim() || manifest.version.length > 80 ||
      !/^[a-f0-9]{64}$/.test(manifest.strategySha256) ||
      manifest.engineSha256 !== undefined && !/^[a-f0-9]{64}$/.test(manifest.engineSha256)) throw new Error('更新包格式或协议版本不兼容。')
    const policy = regularFile(join(dirname(path), 'strategy.json'), 1024 * 1024)
    if (hash(policy) !== manifest.strategySha256) throw new Error('翻译策略校验失败。')
    const strategy = parseStrategy(JSON.parse(policy.toString()))
    const engine = manifest.engineSha256 ? regularFile(join(dirname(path), 'engine.cjs'), 10 * 1024 * 1024) : undefined
    if (engine && hash(engine) !== manifest.engineSha256) throw new Error('翻译模块校验失败。')
    const canonical: UpdateManifest = { format: manifest.format, protocolVersion: 1, version: manifest.version,
      strategySha256: manifest.strategySha256, ...(manifest.engineSha256 ? { engineSha256: manifest.engineSha256 } : {}) }
    return { manifest: canonical, strategy, engine, policy, id: hash(JSON.stringify(canonical)) }
  }

  import(path: string, base: Release = this.builtin): Release {
    // A plain strategy JSON is a data-only update; executable updates require a manifest.
    const json = JSON.parse(regularFile(path, 1024 * 1024).toString())
    let data: ReturnType<ReleaseStore['readPackage']>
    if (json.format === 'readingtime-translation-update') data = this.readPackage(path)
    else {
      const strategy = parseStrategy(json)
      const policy = Buffer.from(JSON.stringify(strategy, null, 2) + '\n')
      const engine = base.enginePath === this.builtin.enginePath ? undefined : regularFile(base.enginePath, 10 * 1024 * 1024)
      const manifest: UpdateManifest = { format: 'readingtime-translation-update', protocolVersion: 1,
        version: strategy.version, strategySha256: hash(policy), ...(engine ? { engineSha256: hash(engine) } : {}) }
      data = { strategy, policy, engine, manifest, id: hash(JSON.stringify(manifest)) }
    }
    const destination = join(this.root, 'versions', data.id)
    if (!existsSync(destination)) {
      const temporary = mkdtempSync(join(this.root, 'versions', '.staging-'))
      try {
        writeFileSync(join(temporary, 'strategy.json'), data.policy, { mode: 0o600 })
        if (data.engine) writeFileSync(join(temporary, 'engine.cjs'), data.engine, { mode: 0o600 })
        writeFileSync(join(temporary, 'manifest.json'), JSON.stringify(data.manifest, null, 2), { mode: 0o600 })
        renameSync(temporary, destination)
      } finally { rmSync(temporary, { recursive: true, force: true }) }
    }
    return this.get(data.id)
  }
}
