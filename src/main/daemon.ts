// 本地服务：只监听 127.0.0.1，供 MCP 桥接进程调用。
// 连接信息（端口和 token）写在 ~/.flyingdraws/daemon.json。
import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// signal 在调用方断开连接（还没收到回复就走了）时中止：长轮询靠它撤下等待，免得结果交给已经不在的人
export type Handler = (body: Record<string, unknown>, ctx: { signal: AbortSignal }) => Promise<unknown>

export interface DaemonInfo {
  port: number
  token: string
  pid: number
  startedAt: string
}

const MAX_BODY = 1024 * 1024

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on('data', (c: Buffer) => {
      if (failed) return
      size += c.length
      if (size > MAX_BODY) {
        failed = true
        req.resume()
        reject(new HttpError(413, 'body too large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (failed) return
      if (!chunks.length) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new HttpError(400, 'invalid JSON'))
      }
    })
    req.on('error', (err) => {
      if (!failed) reject(err)
    })
  })
}

function sameToken(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export async function startDaemon(
  infoPath: string,
  routes: Record<string, Handler>
): Promise<{ info: DaemonInfo; close: () => Promise<void> }> {
  const token = randomBytes(24).toString('hex')

  const server = http.createServer(async (req, res) => {
    const send = (status: number, payload: unknown, closeConn = false) => {
      if (res.headersSent) return
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        ...(closeConn ? { connection: 'close' } : {})
      })
      res.end(JSON.stringify(payload))
    }
    try {
      // 只接受本机非浏览器的调用：浏览器请求会带 Origin，Host 不是 127.0.0.1 的可能是 DNS 重绑定
      if (req.headers.origin) throw new HttpError(403, 'browser requests are not allowed')
      if (!req.headers.host?.startsWith('127.0.0.1:')) throw new HttpError(403, 'bad host')
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/health') return send(200, { ok: true, pid: process.pid })
      if (!sameToken(String(req.headers['x-flyingdraws-token'] ?? ''), token)) throw new HttpError(401, 'bad token')
      if (req.method !== 'POST') throw new HttpError(405, 'use POST')
      const handler = routes[url.pathname]
      if (!handler) throw new HttpError(404, `no route ${url.pathname}`)
      const body = await readBody(req)
      const aborter = new AbortController()
      res.once('close', () => {
        if (!res.writableFinished) aborter.abort()
      })
      send(200, await handler(body, { signal: aborter.signal }))
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 413) res.once('finish', () => req.destroy())
      send(status, { error: err instanceof Error ? err.message : String(err) }, status === 413)
    }
  })
  // 长轮询最多挂 60 秒，关掉 Node 默认的请求超时
  server.requestTimeout = 0
  server.headersTimeout = 10_000

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as { port: number }).port
  const info: DaemonInfo = { port, token, pid: process.pid, startedAt: new Date().toISOString() }
  await mkdir(dirname(infoPath), { recursive: true })
  const tmpInfoPath = `${infoPath}.${process.pid}.tmp`
  await writeFile(tmpInfoPath, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(tmpInfoPath, infoPath)

  const close = async () => {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    try {
      const current = JSON.parse(await readFile(infoPath, 'utf8')) as DaemonInfo
      if (current.pid === process.pid) await unlink(infoPath)
    } catch {
      // 文件已经不在或被别的实例改写，不用管
    }
  }
  return { info, close }
}

export interface DaemonHandle {
  close: () => Promise<void>
}

/**
 * 协调 daemon 启动与退出清理，避免应用在 startDaemon 尚未完成时退出导致 daemon.json 残留。
 */
export function createDaemonLifecycle() {
  let quitting = false
  let daemonPromise: Promise<DaemonHandle> | null = null
  let daemonClosed = false

  const closeOnce = (): Promise<void> | null => {
    if (daemonClosed || !daemonPromise) return null
    daemonClosed = true
    return daemonPromise.then(
      ({ close }) => close(),
      () => undefined
    )
  }

  return {
    isQuitting: (): boolean => quitting,
    markQuitting: (): void => {
      quitting = true
    },
    start: (starter: () => Promise<DaemonHandle>): Promise<void> => {
      if (quitting) return Promise.resolve()
      daemonPromise = starter()
      return daemonPromise.then(
        async () => {
          if (quitting) await closeOnce()
        },
        (err) => {
          if (!quitting) throw err
        }
      )
    },
    closeOnQuit: (): Promise<void> | null => {
      quitting = true
      return closeOnce()
    }
  }
}
