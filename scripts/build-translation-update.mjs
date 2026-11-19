import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinModules } from 'node:module'
import { build } from 'vite'
import { parseStrategy } from '../src/translation/strategy.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
if (!option('--policy') || !option('--out')) {
  console.error('Usage: npm run runtime:pack -- --policy strategy.json --out /path/to/new-package [--engine src/translation/engine.ts] [--version my-version]')
  process.exit(1)
}
const destination = resolve(option('--out'))
if (existsSync(destination)) throw new Error('输出目录已存在，请选择新的版本目录。')
const strategy = parseStrategy(JSON.parse(readFileSync(resolve(option('--policy')), 'utf8')))
const version = option('--version') || strategy.version
if (!version.trim() || version.length > 80) throw new Error('版本名无效。')

// Runs in the developer's checkout, separately from the running reader. Never
// writes the app's active pointer or claims to evaluate translation semantics.
for (const task of ['typecheck', 'test:unit']) execFileSync('npm', ['run', task], { cwd: root, stdio: 'inherit' })
mkdirSync(dirname(destination), { recursive: true })
const temporary = mkdtempSync(join(dirname(destination), '.translation-update-'))
const hash = value => createHash('sha256').update(value).digest('hex')
try {
  const policy = JSON.stringify(strategy, null, 2) + '\n'
  writeFileSync(join(temporary, 'strategy.json'), policy)
  const manifest = { format: 'readingtime-translation-update', protocolVersion: 1, version, strategySha256: hash(policy) }
  const engine = option('--engine')
  if (engine) {
    await build({ configFile: false, root,
      build: { outDir: temporary, emptyOutDir: false, target: 'node22', minify: false,
        lib: { entry: resolve(engine), formats: ['cjs'], fileName: () => 'engine.cjs' },
        rollupOptions: { external: [...builtinModules, ...builtinModules.map(m => 'node:' + m)],
          output: { inlineDynamicImports: true } } }
    })
    manifest.engineSha256 = hash(readFileSync(join(temporary, 'engine.cjs')))
  }
  writeFileSync(join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  renameSync(temporary, destination)
  console.log(`更新包已生成：${join(destination, 'manifest.json')}\n在阅读器设置 → 翻译偏好 → 导入翻译更新中选择此文件。`)
} finally { rmSync(temporary, { recursive: true, force: true }) }
