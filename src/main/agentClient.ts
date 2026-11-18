import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'

export interface HostEvent {
  type: 'event'
  seq: number
  run_id: string | null
  req: number | null
  event: string
  data: Record<string, unknown>
}
interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  waitDone: boolean
  accepted: boolean
  done: boolean
  result?: unknown
  error?: Error
}
export class AgentClient extends EventEmitter {
  private readonly launch: { command: string; args: string[]; env?: NodeJS.ProcessEnv }
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, Pending>()
  private serial = 0
  private starting: Promise<void> | null = null

  constructor(launch: { command: string; args: string[]; env?: NodeJS.ProcessEnv }) { super(); this.launch = launch }
  get alive(): boolean { return this.child !== null && this.child.exitCode === null && !this.child.killed }

  start(): Promise<void> {
    if (this.starting) return this.starting
    if (this.alive) return Promise.resolve()
    this.starting = this.spawnHost().finally(() => { this.starting = null })
    return this.starting
  }
  private async spawnHost(): Promise<void> {
    const child = spawn(this.launch.command, this.launch.args, {
      env: this.launch.env ?? process.env, windowsHide: true, stdio: 'pipe'
    })
    this.child = child
    // Consume diagnostics without retaining or forwarding possible credentials.
    child.stderr.resume()
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      if (this.child !== child) return
      if (Buffer.byteLength(line) > 10 * 1024 * 1024) {
        this.fail(new Error('内核响应超过大小上限'), child)
        child.kill()
        return
      }
      try { this.receive(JSON.parse(line)) }
      catch { this.fail(new Error('内核返回了无效的协议数据'), child); child.kill() }
    })
    child.once('error', () => this.fail(new Error('无法启动 Fuxi 内核，请先构建内核或检查程序路径'), child))
    child.once('close', code => {
      lines.close()
      this.fail(new Error(`Fuxi 内核已退出${code === null ? '' : `（${code}）`}`), child)
    })
    try {
      const hello = await this.request('initialize', { protocol: 1, client: { name: 'Flying draws', version: '0.0.1' } }) as { protocol?: number }
      if (hello?.protocol !== 1) throw new Error('内核协议版本不兼容，请重新构建随应用分发的 Fuxi')
    } catch (error) {
      child.kill()
      this.fail(error instanceof Error ? error : new Error('内核初始化失败'), child)
      throw error
    }
  }
  private fail(error: Error, child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return
    this.child = null
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error) }
    this.pending.clear()
    this.emit('disconnected', error)
  }
  private settle(id: number): void {
    const item = this.pending.get(id)
    if (!item || !item.accepted || (item.waitDone && !item.done)) return
    clearTimeout(item.timer)
    this.pending.delete(id)
    if (item.error) item.reject(item.error)
    else item.resolve(item.result)
  }
  private receive(frame: Record<string, unknown>): void {
    if (frame.type === 'fatal') {
      const child = this.child
      if (child) {
        this.fail(new Error(typeof frame.message === 'string' ? frame.message : '内核启动失败'), child)
        child.kill()
      }
      return
    }
    if (frame.type === 'event') {
      const event = frame as unknown as HostEvent
      const pending = typeof event.req === 'number' ? this.pending.get(event.req) : undefined
      if (pending) {
        if (event.event === 'done') pending.done = true
        const data = event.data ?? {}
        if (event.event === 'error' && typeof data.error === 'string') pending.error = new Error(data.error)
        if (typeof data.error === 'string' && data.error) pending.error = new Error(data.error)
        this.settle(event.req!)
      }
      this.emit('event', event)
      return
    }
    if (typeof frame.id !== 'number') throw new Error('invalid response')
    const item = this.pending.get(frame.id)
    if (!item) return
    if (frame.error && typeof frame.error === 'object') {
      const error = frame.error as { code?: string; message?: string }
      clearTimeout(item.timer)
      this.pending.delete(frame.id)
      item.reject(new Error(error.message || `内核请求失败：${error.code || 'unknown'}`))
    } else {
      item.accepted = true
      item.result = frame.result
      this.settle(frame.id)
    }
  }
  request(method: string, params: unknown = {}, waitDone = false, timeout = 30_000): Promise<unknown> {
    const child = this.child
    if (!child || child.killed) return Promise.reject(new Error('Fuxi 内核尚未连接'))
    const id = ++this.serial
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('内核请求超时；请检查连接状态，不要重复发起正在执行的任务'))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer, waitDone, accepted: false, done: false })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        if (!error) return
        const item = this.pending.get(id)
        if (item) { clearTimeout(item.timer); this.pending.delete(id); item.reject(new Error('内核输入通道已关闭')) }
      })
    })
  }
  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    await this.request('shutdown', {}, false, 1500).catch(() => undefined)
    child.stdin.end()
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
        if (process.platform === 'win32' && child.pid) {
          execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve())
        } else { child.kill(); resolve() }
      }, 12_000)
      child.once('close', () => { clearTimeout(timer); resolve() })
    })
  }
}
