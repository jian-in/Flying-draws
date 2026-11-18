import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LibraryStore, parseAndValidateLibraryJson } from '../src/main/library.ts'
import {
  isExcalidrawLibraryBrowseUrl,
  LIBRARY_CALLBACK_URL,
  parseLibraryInstallNavigation,
  validateRemoteLibraryUrl
} from '../src/shared/library.ts'

test('isExcalidrawLibraryBrowseUrl 仅匹配 HTTPS 官方素材库目录页', () => {
  assert.equal(
    isExcalidrawLibraryBrowseUrl(
      'https://libraries.excalidraw.com?target=_blank&referrer=https://flyingdraws.local/library-callback&useHash=true'
    ),
    true
  )
  assert.equal(isExcalidrawLibraryBrowseUrl('http://libraries.excalidraw.com'), false)
  assert.equal(isExcalidrawLibraryBrowseUrl('https://excalidraw.com'), false)
  assert.equal(isExcalidrawLibraryBrowseUrl('https://evil-libraries.excalidraw.com.attacker.example'), false)
})

test('validateRemoteLibraryUrl 只放行官方白名单域名下的 HTTPS .excalidrawlib 地址', () => {
  const valid1 = 'https://libraries.excalidraw.com/libraries/youritjang/software-architecture.excalidrawlib'
  const valid2 =
    'https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/aws-architecture-icons.excalidrawlib'
  assert.equal(validateRemoteLibraryUrl(valid1), valid1)
  assert.equal(validateRemoteLibraryUrl(valid2), valid2)

  assert.throws(() => validateRemoteLibraryUrl('http://libraries.excalidraw.com/a.excalidrawlib'), /HTTPS/)
  assert.throws(() => validateRemoteLibraryUrl('https://evil.example.com/a.excalidrawlib'), /未知域名/)
  assert.throws(
    () => validateRemoteLibraryUrl('https://raw.githubusercontent.com/other-org/repo/main/a.excalidrawlib'),
    /未知域名/
  )
  assert.throws(() => validateRemoteLibraryUrl('https://libraries.excalidraw.com/libraries/not-a-lib.json'), /后缀/)
})

test('parseLibraryInstallNavigation 兼容本地回跳地址与 excalidraw.com 回退地址，并拦截恶意源', () => {
  const libUrl = 'https://libraries.excalidraw.com/libraries/demo/icons.excalidrawlib'
  const callbackHit = parseLibraryInstallNavigation(
    `${LIBRARY_CALLBACK_URL}#addLibrary=${encodeURIComponent(libUrl)}&token=abc123`
  )
  assert.deepEqual(callbackHit, { libraryUrl: libUrl, token: 'abc123' })

  const fallbackHit = parseLibraryInstallNavigation(
    `https://excalidraw.com/#addLibrary=${encodeURIComponent(libUrl)}&token=xyz`
  )
  assert.deepEqual(fallbackHit, { libraryUrl: libUrl, token: 'xyz' })

  assert.equal(parseLibraryInstallNavigation('https://libraries.excalidraw.com/?sort=default'), null)
  assert.throws(
    () =>
      parseLibraryInstallNavigation(
        `${LIBRARY_CALLBACK_URL}#addLibrary=${encodeURIComponent('https://attacker.example/bad.excalidrawlib')}`
      ),
    /未知域名/
  )
})

test('parseAndValidateLibraryJson 兼容 v1 / v2 素材库结构并拦截超限与非法内容', () => {
  const v2 = JSON.stringify({
    type: 'excalidrawlib',
    version: 2,
    libraryItems: [{ id: 'item-1', status: 'published', elements: [] }]
  })
  assert.equal(parseAndValidateLibraryJson(v2).itemCount, 1)

  const v1 = JSON.stringify({
    type: 'excalidrawlib',
    version: 1,
    library: [[{ id: 'el-1', type: 'rectangle' }]]
  })
  assert.equal(parseAndValidateLibraryJson(v1).itemCount, 1)

  assert.throws(() => parseAndValidateLibraryJson(v2, 16), /体积超出上限/)
  assert.throws(() => parseAndValidateLibraryJson('{bad json'), /不是合法的 JSON/)
  assert.throws(() => parseAndValidateLibraryJson(JSON.stringify({ type: 'excalidraw', elements: [] })), /不是有效的/)
})

test('LibraryStore 原子落盘、重启恢复，并在损坏文件时自动备份归档不崩溃', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flyingdraws-library-store-'))
  try {
    const filePath = join(dir, 'library.excalidrawlib')
    const store = new LibraryStore(filePath)

    assert.equal(await store.load(), null)

    const items = [
      { id: 'lib-1', status: 'unpublished', created: 1, elements: [{ id: 'e1', type: 'rectangle' }] },
      { id: 'lib-2', status: 'published', created: 2, elements: [{ id: 'e2', type: 'ellipse' }] }
    ]
    await store.save({ libraryItems: items })
    assert.ok(existsSync(filePath))

    const rawOnDisk = JSON.parse(readFileSync(filePath, 'utf8')) as { type: string; version: number; libraryItems: unknown[] }
    assert.equal(rawOnDisk.type, 'excalidrawlib')
    assert.equal(rawOnDisk.version, 2)
    assert.equal(rawOnDisk.libraryItems.length, 2)

    const reloaded = await new LibraryStore(filePath).load()
    assert.deepEqual(reloaded, { libraryItems: items })

    // 写入损坏内容后再次 load：自动改名备份并返回 null，后续重新 save 正常可用
    writeFileSync(filePath, '{corrupted', 'utf8')
    assert.equal(await store.load(), null)
    const files = readdirSync(dir)
    assert.ok(files.some((name) => name.startsWith('library.excalidrawlib.corrupt-')))

    await store.save({ libraryItems: [items[0]] })
    assert.deepEqual(await store.load(), { libraryItems: [items[0]] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
