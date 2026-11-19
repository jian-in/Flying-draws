import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDaemonLifecycle, startDaemon, type DaemonHandle } from '../src/main/daemon.ts'

test('createDaemonLifecycle：startDaemon 尚未完成时触发退出，仍等待其完成后关闭并清理 daemon.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flyingdraws-daemon-'))
  const infoPath = join(dir, 'daemon.json')

  try {
    const lifecycle = createDaemonLifecycle()
    let releaseStart!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    let closeCalls = 0

    const startPromise = lifecycle.start(async (): Promise<DaemonHandle> => {
      await gate
      const { close } = await startDaemon(infoPath, {})
      return {
        close: async () => {
          closeCalls += 1
          await close()
        }
      }
    })

    // 模拟在 startDaemon 挂起期间用户关闭窗口触发 will-quit
    const closing = lifecycle.closeOnQuit()
    assert.ok(closing !== null)

    releaseStart()
    await Promise.all([startPromise, closing])

    assert.equal(closeCalls, 1)
    assert.equal(existsSync(infoPath), false)
    assert.equal(lifecycle.closeOnQuit(), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createDaemonLifecycle：before-quit 早于 start() 触发时不再启动 daemon', async () => {
  const lifecycle = createDaemonLifecycle()
  let started = false

  lifecycle.markQuitting()
  assert.equal(lifecycle.isQuitting(), true)

  await lifecycle.start(async () => {
    started = true
    return { close: async () => {} }
  })

  assert.equal(started, false)
  assert.equal(lifecycle.closeOnQuit(), null)
})

test('createDaemonLifecycle：正常启动后退出只执行一次清理并删除 daemon.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flyingdraws-daemon-'))
  const infoPath = join(dir, 'daemon.json')

  try {
    const lifecycle = createDaemonLifecycle()
    await lifecycle.start(() => startDaemon(infoPath, {}))
    assert.equal(existsSync(infoPath), true)

    const closing = lifecycle.closeOnQuit()
    assert.ok(closing !== null)
    await closing

    assert.equal(existsSync(infoPath), false)
    assert.equal(lifecycle.closeOnQuit(), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('startDaemon：调用方在回复前断开连接时，路由拿到的 signal 会中止；正常回复时不会', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flyingdraws-daemon-'))
  const infoPath = join(dir, 'daemon.json')
  let hangingSignal: AbortSignal | null = null
  let finishedSignal: AbortSignal | null = null
  const { info, close } = await startDaemon(infoPath, {
    '/hang': (_body, ctx) => {
      hangingSignal = ctx.signal
      return new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true }))
    },
    '/quick': async (_body, ctx) => {
      finishedSignal = ctx.signal
      return { ok: true }
    }
  })
  const post = (path: string, signal?: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: info.port, path, method: 'POST', headers: { 'x-flyingdraws-token': info.token, 'content-type': 'application/json', 'content-length': 2 }, signal },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        }
      )
      req.on('error', reject)
      req.end('{}')
    })
  try {
    assert.equal(await post('/quick'), '{"ok":true}')
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(finishedSignal!.aborted, false)

    const abort = new AbortController()
    const pending = post('/hang', abort.signal).catch((err: Error) => err.name)
    for (let i = 0; i < 50 && !hangingSignal; i++) await new Promise((r) => setTimeout(r, 10))
    assert.ok(hangingSignal, '路由没有被调用')
    abort.abort()
    assert.equal(await pending, 'AbortError')
    for (let i = 0; i < 50 && !hangingSignal!.aborted; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(hangingSignal!.aborted, true)
  } finally {
    await close()
    rmSync(dir, { recursive: true, force: true })
  }
})
