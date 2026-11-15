// 本地服务：只监听 127.0.0.1，供 MCP 桥接进程调用。
// 连接信息（端口和 token）写在 ~/.sketchlink/daemon.json。
import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type Handler = (body: Record<string, unknown>) => Promise<unknown>

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
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new HttpError(400, 'invalid JSON'))
      }
    })
    req.on('error', reject)
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
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    }
    try {
      // 只接受本机非浏览器的调用：浏览器请求会带 Origin，Host 不是 127.0.0.1 的可能是 DNS 重绑定
      if (req.headers.origin) throw new HttpError(403, 'browser requests are not allowed')
      if (!req.headers.host?.startsWith('127.0.0.1:')) throw new HttpError(403, 'bad host')
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/health') return send(200, { ok: true, pid: process.pid })
      if (!sameToken(String(req.headers['x-sketchlink-token'] ?? ''), token)) throw new HttpError(401, 'bad token')
      if (req.method !== 'POST') throw new HttpError(405, 'use POST')
      const handler = routes[url.pathname]
      if (!handler) throw new HttpError(404, `no route ${url.pathname}`)
      const body = await readBody(req)
      send(200, await handler(body))
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      send(status, { error: err instanceof Error ? err.message : String(err) })
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
  await writeFile(infoPath, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 })

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
