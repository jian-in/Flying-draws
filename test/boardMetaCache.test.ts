import assert from 'node:assert/strict'
import { mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
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

test('原子替换成等长内容、mtime 也一模一样时照样重新解析', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fd-meta-'))
  try {
    const file = join(dir, 'a.excalidraw')
    const sameTime = 1_767_225_600 // 整秒，经 Date 设置也不会有亚毫秒舍入
    atomicWrite(file, scene('标题A', 2))
    utimesSync(file, sameTime, sameTime)
    const before = statSync(file, { bigint: true })
    const cache = new BoardMetaCache()
    assert.equal((await cache.read('a', file)).title, '标题A')
    atomicWrite(file, scene('标题B', 2)) // 长度一样
    utimesSync(file, sameTime, sameTime)
    const after = statSync(file, { bigint: true })
    assert.equal(after.size, before.size)
    assert.equal(after.mtimeNs, before.mtimeNs)
    assert.equal((await cache.read('a', file)).title, '标题B')
    assert.equal(cache.parses, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readAll 按顺序返回、读不了的是 null，并清掉不在这批里的条目', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fd-meta-'))
  try {
    const boards = Array.from({ length: 9 }, (_, i) => ({ id: `b${i}`, file: join(dir, `b${i}.excalidraw`) }))
    boards.forEach((b, i) => {
      if (i !== 4) atomicWrite(b.file, scene(`第${i}块`, i))
    })
    const cache = new BoardMetaCache()
    const gone = join(dir, 'gone.excalidraw')
    atomicWrite(gone, scene('已删', 1))
    await cache.read('gone', gone)
    const metas = await cache.readAll(boards)
    assert.deepEqual(
      metas.map((m) => m?.title ?? null),
      boards.map((_, i) => (i === 4 ? null : `第${i}块`))
    )
    assert.equal(cache.size, 8)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('整份读文件的并发上限挂在实例上：两批列表同时来也不超过上限', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fd-meta-'))
  try {
    const boards = Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, file: join(dir, `b${i}.excalidraw`) }))
    boards.forEach((b, i) => atomicWrite(b.file, scene(`第${i}块`, 200)))
    const cache = new BoardMetaCache(3)
    const [x, y] = await Promise.all([cache.readAll(boards), cache.readAll([...boards].reverse())])
    assert.equal(x.filter(Boolean).length, 12)
    assert.equal(y.filter(Boolean).length, 12)
    assert.ok(cache.peakReading >= 1 && cache.peakReading <= 3, `同时读了 ${cache.peakReading} 块`)
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
