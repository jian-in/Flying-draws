import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { atomicWriteBytes, atomicWriteJson } from '../src/main/atomicWrite.ts'

test('图片原子写会替换残缺旧文件，并保留提交时的字节', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flyingdraws-image-'))
  try {
    const file = join(dir, 'blob')
    writeFileSync(file, 'partial')
    const bytes = Buffer.from([137, 80, 78, 71, 1, 2, 3])
    const write = atomicWriteBytes(file, bytes)
    bytes.fill(0)
    await write
    assert.deepEqual([...readFileSync(file)], [137, 80, 78, 71, 1, 2, 3])
    assert.deepEqual(readdirSync(dir), ['blob'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('同一个文件同时写多次：都成功，最后落盘的是最后一次调用的内容，不留临时文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flyingdraws-write-'))
  try {
    const file = join(dir, 'boards', 'a.excalidraw')
    const big = 'x'.repeat(200_000) // 第一份故意写得慢一些，不排队的话它会晚于后面几份落盘
    await Promise.all([
      atomicWriteJson(file, { n: 1, big }),
      atomicWriteJson(file, { n: 2 }),
      atomicWriteJson(file, { n: 3 }),
      atomicWriteJson(file, { n: 4 })
    ])
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { n: 4 })
    assert.deepEqual(readdirSync(join(dir, 'boards')), ['a.excalidraw'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('排队期间调用方改了对象，写下去的仍是调用那一刻的内容；一次失败不影响后面的写入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flyingdraws-write-'))
  try {
    const file = join(dir, 'b.json')
    const scene = { version: 1 }
    const first = atomicWriteJson(file, scene)
    scene.version = 99
    await first
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1 })

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    assert.throws(() => atomicWriteJson(file, cyclic))
    await atomicWriteJson(file, { version: 2 })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 2 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
