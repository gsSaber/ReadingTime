import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('macOS identity avoids the system App launcher alias and preserves the data directory', () => {
  const config = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  // OmniDock matches a Dock title against the last bundle-ID component.
  // "com.readingtime.app" therefore captures clicks on the system "App" tile.
  assert.equal(config.build.appId, 'com.readingtime.reader')
  assert.notEqual(config.build.appId.split('.').at(-1).toLowerCase(), 'app')
  // Electron's userData directory derives from this package name, not appId.
  assert.equal(config.name, 'reading-time')
  assert.equal(config.build.fileAssociations[0].ext, 'pdf')
  assert.equal(config.build.fileAssociations[0].rank, 'Alternate')
})
