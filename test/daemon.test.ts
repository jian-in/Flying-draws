import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
