import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('.', import.meta.url)))
const sourceRoot = join(root, 'node_modules', 'pdfjs-dist')
const targetRoot = join(root, 'src', 'renderer', 'public', 'pdfjs')
const directories = ['cmaps', 'standard_fonts', 'wasm']

if (!existsSync(sourceRoot)) {
  console.error('pdfjs-dist is not installed. Run npm install first.')
  process.exitCode = 1
} else {
  mkdirSync(targetRoot, { recursive: true })
  for (const directory of directories) {
    const source = join(sourceRoot, directory)
    const target = join(targetRoot, directory)
    rmSync(target, { recursive: true, force: true })
    cpSync(source, target, { recursive: true })
  }

  // PDF.js 5.x uses the stage-3 Map.prototype.getOrInsertComputed method.
  // Chromium 140 (Electron 38) does not ship it yet, so patch the worker
  // entry directly. The renderer entry receives the same polyfill inline.
  let workerSource = readFileSync(
    join(sourceRoot, 'build', 'pdf.worker.mjs'),
    'utf8'
  )
  // PDF.js normally stretches a fallback font across a whole extracted line.
  // Its word boundaries then drift from the embedded font painted on canvas.
  // Keep Latin words as separate positioned items, using the worker's actual
  // glyph advances/kerning. Preserve the original combining/bidi path for other
  // scripts and vertical writing. Fail loudly if a PDF.js upgrade changes this.
  const whitespaceBranch = 'if (!keepWhiteSpace && category.isWhitespace) {'
  if (workerSource.split(whitespaceBranch).length !== 2) {
    throw new Error('PDF.js text extraction patch needs review for this version.')
  }
  workerSource = workerSource.replace(whitespaceBranch, `${whitespaceBranch}
          if (!intersector && !font.vertical && /^[\\p{Script=Latin}\\p{M}\\p{N}\\p{P}]+$/u.test(textContentItem.str.join(""))) {
            flushTextContentItem();
          }`)
  const polyfill = [
    'const __installUpsert = (Ctor) => {',
    "  if (!Ctor || Ctor.prototype.getOrInsertComputed) return;",
    "  Object.defineProperty(Ctor.prototype, 'getOrInsertComputed', {",
    '    configurable: true,',
    '    writable: true,',
    '    value: function (key, callback) {',
    '      if (this.has(key)) return this.get(key);',
    '      const value = callback(key);',
    '      this.set(key, value);',
    '      return value;',
    '    }',
    '  });',
    '};',
    '__installUpsert(Map);',
    '__installUpsert(WeakMap);',
    ''
  ].join('\n')
  writeFileSync(join(targetRoot, 'pdf.worker.min.mjs'), polyfill + workerSource, 'utf8')
  console.log('PDF.js runtime assets are ready.')
}
