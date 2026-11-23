// Build against Node-API, whose binary ABI is shared by Node and Electron.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
if (process.platform === 'darwin') {
  const prefix = dirname(dirname(process.execPath))
  const headers = [process.env.NODE_INCLUDE_DIR, join(prefix, 'include/node'),
    '/opt/homebrew/include/node', '/usr/local/include/node'].find(p => p && existsSync(join(p, 'node_api.h')))
  if (!headers) throw new Error('请用 NODE_INCLUDE_DIR 指定包含 node_api.h 的 Node.js 头文件目录。')
  mkdirSync('out/native', { recursive: true })
  execFileSync('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-mmacosx-version-min=12.0', '-O2', '-bundle',
    '-undefined', 'dynamic_lookup', '-I', headers, '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'Carbon',
    'native/macos/selection.mm', '-o', 'out/native/selection.node'], { stdio: 'inherit' })
}
