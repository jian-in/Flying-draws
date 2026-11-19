import assert from 'node:assert/strict'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BoardMetaCache } from '../src/main/boardMetaCache.ts'

const scene = (title: string, n: number) =>
  JSON.stringify({ type: 'excalidraw', elements: Array.from({ length: n }, (_, i) => ({ id: `e${i}` })), flyingdraws: { version: n, title } })

// 和 atomicWriteJson 一样：先写临时文件再 rename
const atomicWrite = (file: string, text: string) => {
  writeFileSync(`${file}.tmp`, text)
  renameSync(`${file}.tmp`, file)
}

test('文件没动过时直接用缓存，原子写入后重新解析', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fd-meta-'))
  try {
    const file = join(dir, 'a.excalidraw')
    atomicWrite(file, scene('第一版', 2))
    const cache = new BoardMetaCache()
    const m1 = await cache.read('a', file)
    assert.equal(m1.title, '第一版')
    assert.equal(m1.elements, 2)
    await cache.read('a', file)
    await cache.read('a', file)
    assert.equal(cache.parses, 1)

    atomicWrite(file, scene('第二版', 3))
    const m2 = await cache.read('a', file)
    assert.equal(m2.title, '第二版')
    assert.equal(m2.elements, 3)
    assert.equal(cache.parses, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文件不存在时抛错；retain 清掉不在列表里的条目', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fd-meta-'))
  try {
    const a = join(dir, 'a.excalidraw')
    const b = join(dir, 'b.excalidraw')
    atomicWrite(a, scene('a', 1))
    atomicWrite(b, scene('b', 1))
    const cache = new BoardMetaCache()
    await cache.read('a', a)
    await cache.read('b', b)
    assert.equal(cache.size, 2)
    cache.retain([a])
    assert.equal(cache.size, 1)
    await assert.rejects(cache.read('c', join(dir, 'c.excalidraw')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
