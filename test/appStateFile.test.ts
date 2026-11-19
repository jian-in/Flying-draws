import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { patchAppStateFile, readAppStateFile } from '../src/main/appStateFile.ts'
import { scenePrefsKey } from '../src/shared/scenePrefs.ts'

test('state.json 合并写入：写当前画板不会冲掉深浅色，反之亦然', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fd-state-'))
  try {
    const path = join(dir, 'nested', 'state.json')
    assert.deepEqual(readAppStateFile(path), {})
    assert.equal(patchAppStateFile(path, { theme: 'dark' }), true)
    assert.equal(patchAppStateFile(path, { currentBoard: 'notes' }), true)
    assert.deepEqual(readAppStateFile(path), { theme: 'dark', currentBoard: 'notes' })
    assert.equal(patchAppStateFile(path, { theme: 'dark' }), false, '没变就不写')
    assert.equal(patchAppStateFile(path, { currentBoard: 'default' }), true)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { theme: 'dark', currentBoard: 'default' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('state.json 读到旧格式、坏 JSON 或非法 theme 时不报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fd-state-'))
  try {
    const path = join(dir, 'state.json')
    writeFileSync(path, JSON.stringify({ currentBoard: 'm1' }))
    assert.deepEqual(readAppStateFile(path), { currentBoard: 'm1' })
    writeFileSync(path, JSON.stringify({ currentBoard: 'm1', theme: 'purple' }))
    assert.deepEqual(readAppStateFile(path), { currentBoard: 'm1' })
    writeFileSync(path, '{oops')
    assert.deepEqual(readAppStateFile(path), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scenePrefsKey 只看背景色和网格，不看 theme、缩放、选区', () => {
  const base = { viewBackgroundColor: '#fffbe6', gridModeEnabled: false, theme: 'light', zoom: { value: 1 }, selectedElementIds: {} }
  const k = scenePrefsKey(base)
  assert.equal(scenePrefsKey({ ...base, theme: 'dark', zoom: { value: 2 }, selectedElementIds: { a: true } }), k)
  assert.notEqual(scenePrefsKey({ ...base, viewBackgroundColor: '#1e1e1e' }), k)
  assert.notEqual(scenePrefsKey({ ...base, gridModeEnabled: true }), k)
  assert.equal(scenePrefsKey(undefined), scenePrefsKey({}))
})
