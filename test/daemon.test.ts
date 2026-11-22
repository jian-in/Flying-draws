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

test('startDaemon：四个安全闸门（Origin 403、Host 403、Token 401、MAX_BODY 413）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flyingdraws-daemon-'))
  const infoPath = join(dir, 'daemon.json')
  let routeHits = 0
  const { info, close } = await startDaemon(infoPath, {
    '/echo': async (body) => {
      routeHits += 1
      return { ok: true, size: typeof body.data === 'string' ? body.data.length : 0 }
    }
  })

  const sendRaw = (opts: {
    path?: string
    method?: string
    headers?: Record<string, string>
    body?: string | Buffer
  }) =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const payload = opts.body ?? '{}'
      const req = http.request(
        {
          host: '127.0.0.1',
          port: info.port,
          path: opts.path ?? '/echo',
          method: opts.method ?? 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(payload)),
            ...opts.headers
          }
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} })
          })
        }
      )
      req.on('error', (err) => {
        // 413 触发后服务端会主动 destroy 连接，若写入大包中途遇到 ECONNRESET/EPIPE 忽略写错误等待响应结束
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ECONNRESET' && code !== 'EPIPE') reject(err)
      })
      req.end(payload)
    })

  try {
    // 1. Origin 闸门：浏览器跨源/同源请求直接 403
    const originRes = await sendRaw({
      headers: {
        origin: 'http://evil.example',
        'x-flyingdraws-token': info.token
      }
    })
    assert.equal(originRes.status, 403)
    assert.match(String(originRes.body.error), /browser/i)

    // 2. Host 闸门：非 127.0.0.1:<port> 的 Host（防 DNS 重绑定）直接 403
    const badHostRes = await sendRaw({
      headers: {
        host: `evil.example:${info.port}`,
        'x-flyingdraws-token': info.token
      }
    })
    assert.equal(badHostRes.status, 403)
    assert.match(String(badHostRes.body.error), /host/i)

    const localhostRes = await sendRaw({
      headers: {
        host: `localhost:${info.port}`,
        'x-flyingdraws-token': info.token
      }
    })
    assert.equal(localhostRes.status, 403)

    // 3. Token 闸门：缺失或错误的 x-flyingdraws-token 返回 401
    const missingTokenRes = await sendRaw({})
    assert.equal(missingTokenRes.status, 401)
    assert.match(String(missingTokenRes.body.error), /token/i)

    const wrongTokenRes = await sendRaw({
      headers: { 'x-flyingdraws-token': 'wrong-token-value' }
    })
    assert.equal(wrongTokenRes.status, 401)
    assert.match(String(wrongTokenRes.body.error), /token/i)

    // 4. MAX_BODY 闸门：超过 1 MiB 返回 413
    const oversized = JSON.stringify({ data: 'a'.repeat(1024 * 1024 + 64) })
    const largeRes = await sendRaw({
      headers: { 'x-flyingdraws-token': info.token },
      body: oversized
    })
    assert.equal(largeRes.status, 413)
    assert.match(String(largeRes.body.error), /large/i)

    // 前四个闸门都不应触达业务路由
    assert.equal(routeHits, 0)

    // 正常请求应通过
    const okRes = await sendRaw({
      headers: { 'x-flyingdraws-token': info.token },
      body: JSON.stringify({ data: 'ok' })
    })
    assert.equal(okRes.status, 200)
    assert.deepEqual(okRes.body, { ok: true, size: 2 })
    assert.equal(routeHits, 1)
  } finally {
    await close()
    rmSync(dir, { recursive: true, force: true })
  }
})
