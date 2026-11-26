import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import {
  ACP_PRESETS,
  acpPresetSpec,
  type AcpConfigOption,
  type AcpModeInfo,
  type AcpPresetId,
  type BuiltinAcpPresetId
} from '../shared/agent.ts'

const MAX_FRAME_BYTES = 10 * 1024 * 1024

// cmd.exe 会解释的元字符；和 cross-spawn 的转义规则一致
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, '^$1')
}

function escapeCmdArgument(arg: string): string {
  // 先按 MSVC 规则给参数加引号（反斜杠在引号前要成对），再给 cmd 元字符加 ^
  let out = String(arg)
  out = out.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  out = out.replace(/(?=(\\+?)?)\1$/, '$1$1')
  return `"${out}"`.replace(CMD_META, '^$1')
}

/**
 * Windows 上 .cmd / .bat 不能直接 spawn，要交给 cmd.exe。自己拼整条命令行并关掉 Node 的二次加引号，
 * 程序路径和每个参数里的空格、引号、&、% 都保持原样，参数边界不会被 cmd 拆开或合并。
 */
export function windowsBatchLaunch(
  command: string,
  args: readonly string[],
  comspec: string = process.env['ComSpec'] || process.env['COMSPEC'] || 'cmd.exe'
): { file: string; args: string[]; windowsVerbatimArguments: true } {
  const line = [escapeCmdCommand(command), ...args.map(escapeCmdArgument)].join(' ')
  return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true }
}

function killTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  if (process.platform === 'win32' && child.pid) {
    return new Promise<void>(resolve => {
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve())
    })
  }
  try { child.kill() } catch {}
  return Promise.resolve()
}

function findInPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathEnv = env['PATH'] ?? env['Path'] ?? ''
  if (!pathEnv) return null
  // 只认绝对路径的目录：PATH 里的相对目录（如 . 或 bin）随启动目录指向不同位置，查到的程序不可信
  const dirs = pathEnv.split(delimiter).map(d => d.trim().replace(/^"(.*)"$/, '$1')).filter(d => d && isAbsolute(d))
  const isWin = process.platform === 'win32'
  const exts = isWin
    ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';').map(e => e.trim().toLowerCase()).filter(Boolean)
    : ['']
  const lower = command.toLowerCase()
  const hasExt = isWin && exts.some(ext => ext && lower.endsWith(ext))
  for (const dir of dirs) {
    if (!isWin || hasExt) {
      const candidate = join(dir, command)
      if (existsSync(candidate)) return candidate
    } else {
      for (const ext of exts) {
        const candidate = join(dir, `${command}${ext}`)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return null
}

function findInDirs(names: readonly string[], dirs: readonly string[], platform: NodeJS.Platform): string | null {
  const isWin = platform === 'win32'
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of dirs) {
    if (!dir) continue
    for (const name of names) {
      const lower = name.toLowerCase()
      const hasExt = isWin && exts.some(ext => ext && lower.endsWith(ext))
      if (!isWin || hasExt) {
        const candidate = join(dir, name)
        if (existsSync(candidate)) return candidate
      } else {
        for (const ext of exts) {
          const candidate = join(dir, `${name}${ext}`)
          if (existsSync(candidate)) return candidate
        }
      }
    }
  }
  return null
}

/**
 * 自动探测本机 Antigravity CLI (`agy`) 可执行文件路径。
 * 不写死任何用户名路径，只检查环境变量、标准用户安装目录和 PATH。
 */
export function detectAntigravityBinary(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): string | null {
  return detectAcpPresetBinary('antigravity', env, home, platform)
}

/** 自动探测指定内置 ACP 预设的本机可执行文件（支持 Antigravity / Claude Code / Codex / OpenCode）。 */
export function detectAcpPresetBinary(
  preset: BuiltinAcpPresetId,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): string | null {
  const isWin = platform === 'win32'
  const npmBin = isWin
    ? (env['APPDATA']?.trim() ? join(env['APPDATA'].trim(), 'npm') : join(home, 'AppData', 'Roaming', 'npm'))
    : join(home, '.npm-global', 'bin')
  const localBin = join(home, '.local', 'bin')

  if (preset === 'antigravity') {
    const override = env['FLYINGDRAWS_ACP_BIN']?.trim()
    if (override) {
      if (existsSync(override)) return override
      const fromPath = findInPath(override, env)
      if (fromPath) return fromPath
    }
    if (isWin) {
      const localAppData = env['LOCALAPPDATA']?.trim() || join(home, 'AppData', 'Local')
      const found = findInDirs(['agy.exe'], [join(localAppData, 'agy', 'bin'), localBin], platform)
      if (found) return found
      return findInPath('agy.exe', env) ?? findInPath('agy.cmd', env) ?? findInPath('agy', env)
    }
    return findInPath('agy', env) ?? findInDirs(['agy'], [localBin, '/usr/local/bin', '/opt/homebrew/bin'], platform)
  }

  const binMap: Record<Exclude<BuiltinAcpPresetId, 'antigravity'>, readonly string[]> = {
    claude: ['claude-agent-acp', 'claude-code-acp'],
    codex: ['codex-acp'],
    opencode: ['opencode']
  }
  const names = binMap[preset]
  for (const name of names) {
    const fromPath = findInPath(isWin ? `${name}.cmd` : name, env) ?? findInPath(name, env)
    if (fromPath) return fromPath
  }
  const extraDirs = isWin ? [npmBin, localBin] : [npmBin, localBin, '/usr/local/bin', '/opt/homebrew/bin']
  return findInDirs(names, extraDirs, platform)
}

/** 一次探测全部内置 ACP 预设在当前机器上的可用路径。 */
export function detectAllAcpPresets(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): Record<BuiltinAcpPresetId, string | null> {
  const out = {} as Record<BuiltinAcpPresetId, string | null>
  for (const spec of ACP_PRESETS) {
    out[spec.id] = detectAcpPresetBinary(spec.id, env, home, platform)
  }
  return out
}

/** 解析最终要启动的 ACP 可执行命令：优先用户配置，其次按预设自动探测本机 CLI。 */
export function resolveAcpCommand(
  configuredCommand?: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  preset: AcpPresetId = 'antigravity'
): string {
  const custom = configuredCommand?.trim()
  if (custom) {
    if (isAbsolute(custom) || custom.includes('/') || custom.includes('\\')) {
      // 相对路径先按当前工作目录解析成绝对路径：确认框、信任指纹和实际启动都用这一个路径，
      // 换个目录启动应用时同一串相对路径指向别的程序，指纹也跟着不同，会重新确认
      const full = resolve(custom)
      if (!existsSync(full)) throw new Error(`找不到配置的 ACP 可执行文件：${custom}`)
      return full
    }
    const found = findInPath(custom, env)
    if (found) return found
    throw new Error(`在 PATH 中找不到 ACP 命令「${custom}」，请填写完整路径或留空以自动检测`)
  }
  if (preset === 'custom') {
    throw new Error('自定义 ACP 代理请先填写可执行命令或完整路径。')
  }
  const detected = detectAcpPresetBinary(preset, env, home, platform)
  if (!detected) {
    const spec = acpPresetSpec(preset)
    throw new Error(
      spec
        ? `未检测到本地 ${spec.label} 的 ACP 命令。请先安装（${spec.installHint}），或在 ACP 设置里填写路径。`
        : '未检测到本地 ACP 可执行文件，请在 ACP 设置里填写路径。'
    )
  }
  return detected
}

export interface AcpMcpServer {
  name: string
  command: string
  args: string[]
  env: { name: string; value: string }[]
}

/** 把 Flying draws 的 MCP 字典转成 ACP `session/new` 标准数组，并按当前席位覆盖 FLYINGDRAWS_SEAT。 */
export function toAcpMcpServers(mcpServers: Record<string, unknown>, seatOverride?: string): AcpMcpServer[] {
  const out: AcpMcpServer[] = []
  for (const [name, raw] of Object.entries(mcpServers)) {
    if (!raw || typeof raw !== 'object') continue
    const cfg = raw as { command?: unknown; args?: unknown; env?: unknown }
    if (typeof cfg.command !== 'string' || !cfg.command.trim()) continue
    const args = Array.isArray(cfg.args) ? cfg.args.map(v => String(v)) : []
    const envMap: Record<string, string> = {}
    if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
      for (const [k, v] of Object.entries(cfg.env as Record<string, unknown>)) {
        if (v !== undefined && v !== null) envMap[k] = String(v)
      }
    }
    if (seatOverride && name === 'flying_draws') {
      envMap['FLYINGDRAWS_SEAT'] = seatOverride
    }
    out.push({
      name,
      command: cfg.command,
      args,
      env: Object.entries(envMap).map(([k, v]) => ({ name: k, value: v }))
    })
  }
  return out
}

export interface AcpInitializeResult {
  protocolVersion: number
  agentInfo?: { name?: string; version?: string; title?: string }
  agentCapabilities?: {
    loadSession?: boolean
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean }
    sessionCapabilities?: { resume?: unknown; close?: unknown; load?: unknown; list?: unknown }
  }
  authMethods?: { id: string; name: string; description?: string }[]
}

export interface AcpModelInfo {
  modelId: string
  name?: string
  description?: string
}

export interface AcpSessionResult {
  sessionId: string
  models?: {
    availableModels?: AcpModelInfo[]
    currentModelId?: string
  }
  modes?: {
    currentModeId?: string
    availableModes?: AcpModeInfo[]
  }
  configOptions?: AcpConfigOption[]
  _meta?: Record<string, unknown>
}

export interface AcpPermissionOption {
  optionId: string
  name: string
  kind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string
}

export interface AcpPermissionRequest {
  rpcId: number | string
  sessionId: string
  toolCall: {
    toolCallId?: string
    title?: string
    kind?: string
    rawInput?: unknown
    locations?: unknown
  }
  options: AcpPermissionOption[]
  respond(outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }): void
}

export interface AcpSessionUpdate {
  sessionId: string
  update: Record<string, unknown>
}

export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

interface PendingRpc {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout> | null
}

export interface AcpLaunch {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** 内置预设的登录命令（如 `claude login`）；自定义代理不填，登录报错时改用代理自己给的认证说明 */
  loginHint?: string
}

/** 恢复历史会话的结果：成功、代理没声明恢复能力、恢复请求报错，三种要分开处理。 */
export type AcpResumeResult =
  | { status: 'resumed'; session: AcpSessionResult }
  | { status: 'unsupported' }
  | { status: 'error'; error: Error }

/**
 * 标准 ACP（Agent Client Protocol）stdio JSON-RPC 2.0 客户端。
 * 负责子进程生命周期、双向请求/通知分发与安全退出清理。
 */
export class AcpClient extends EventEmitter {
  private readonly launch: AcpLaunch
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, PendingRpc>()
  private serial = 0
  private starting: Promise<AcpInitializeResult> | null = null
  private initResult: AcpInitializeResult | null = null
  private stderrTail = ''

  constructor(launch: AcpLaunch) {
    super()
    this.launch = launch
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null && !this.child.killed
  }

  get initialized(): AcpInitializeResult | null {
    return this.initResult
  }

  start(): Promise<AcpInitializeResult> {
    if (this.starting) return this.starting
    if (this.alive && this.initResult) return Promise.resolve(this.initResult)
    this.starting = this.spawnAndInit().finally(() => { this.starting = null })
    return this.starting
  }

  private async spawnAndInit(): Promise<AcpInitializeResult> {
    const isWinBatch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(this.launch.command)
    const batch = isWinBatch ? windowsBatchLaunch(this.launch.command, this.launch.args) : null
    const child = batch
      ? spawn(batch.file, batch.args, {
          cwd: this.launch.cwd,
          env: this.launch.env ?? process.env,
          windowsHide: true,
          windowsVerbatimArguments: batch.windowsVerbatimArguments,
          stdio: 'pipe'
        })
      : spawn(this.launch.command, this.launch.args, {
          cwd: this.launch.cwd,
          env: this.launch.env ?? process.env,
          windowsHide: true,
          stdio: 'pipe'
        })
    this.child = child
    this.initResult = null
    this.stderrTail = ''
    child.stdin.on('error', () => {})
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.child !== child) return
      // 只保留最后 1200 字符用于启动诊断，避免内存堆积
      const text = chunk.toString('utf8')
      this.stderrTail = (this.stderrTail + text).slice(-1200)
    })

    let chunks: Buffer[] = []
    let bufferedBytes = 0
    const handleLine = (lineBuf: Buffer): boolean => {
      const trimmed = lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d ? lineBuf.subarray(0, -1) : lineBuf
      const line = trimmed.toString('utf8').trim()
      if (!line) return true
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(line) as Record<string, unknown>
      } catch {
        // 某些 CLI 启动时可能打印非 JSON 日志，未初始化前忽略杂讯，不立刻炸掉
        if (!this.initResult) return true
        this.fail(new Error('ACP 进程返回了无效的 JSON 协议数据'), child)
        void killTree(child)
        return false
      }
      this.receive(frame, child)
      return true
    }

    child.stdout.on('data', (chunk: Buffer) => {
      let offset = 0
      while (offset < chunk.length) {
        if (this.child !== child) { chunks = []; bufferedBytes = 0; return }
        const nl = chunk.indexOf(0x0a, offset)
        if (nl === -1) {
          const part = offset === 0 ? chunk : chunk.subarray(offset)
          bufferedBytes += part.length
          if (bufferedBytes > MAX_FRAME_BYTES) {
            chunks = []
            bufferedBytes = 0
            this.fail(new Error('ACP 响应超过单帧 10 MiB 上限'), child)
            void killTree(child)
            return
          }
          chunks.push(part)
          return
        }
        const part = chunk.subarray(offset, nl)
        const lineBytes = bufferedBytes + part.length
        if (lineBytes > MAX_FRAME_BYTES) {
          chunks = []
          bufferedBytes = 0
          this.fail(new Error('ACP 响应超过单帧 10 MiB 上限'), child)
          void killTree(child)
          return
        }
        const lineBuf = chunks.length ? Buffer.concat([...chunks, part], lineBytes) : part
        chunks = []
        bufferedBytes = 0
        offset = nl + 1
        if (!handleLine(lineBuf)) return
      }
    })

    child.stdout.on('end', () => {
      if (this.child !== child || bufferedBytes === 0) { chunks = []; bufferedBytes = 0; return }
      const lineBuf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, bufferedBytes)
      chunks = []
      bufferedBytes = 0
      handleLine(lineBuf)
    })

    child.once('error', error => {
      this.fail(new Error(`无法启动 ACP 服务（${error.message}），请检查可执行文件路径`), child)
    })
    child.once('close', code => {
      chunks = []
      bufferedBytes = 0
      const detail = this.stderrTail.trim()
      const suffix = code === null ? '' : `（退出码 ${code}）`
      this.fail(new Error(`ACP 进程已退出${suffix}${detail ? `：${detail.slice(-240)}` : ''}`), child)
    })

    try {
      const result = await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'Flying draws', version: '0.1.0' }
      }, 30_000) as AcpInitializeResult
      this.initResult = result
      return result
    } catch (error) {
      void killTree(child)
      this.fail(error instanceof Error ? error : new Error('ACP 初始化失败'), child)
      throw error
    }
  }

  private fail(error: Error, child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return
    this.child = null
    this.initResult = null
    for (const item of this.pending.values()) {
      if (item.timer) clearTimeout(item.timer)
      item.reject(error)
    }
    this.pending.clear()
    this.emit('disconnected', error)
  }

  private writeFrame(frame: unknown): void {
    const child = this.child
    if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) return
    try {
      child.stdin.write(`${JSON.stringify(frame)}\n`)
    } catch {}
  }

  private receive(frame: Record<string, unknown>, child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return
    const hasId = frame.id !== undefined && frame.id !== null
    const method = typeof frame.method === 'string' ? frame.method : null

    // 1. Agent -> Client notification
    if (method && !hasId) {
      if (method === 'session/update' && frame.params && typeof frame.params === 'object') {
        const params = frame.params as Record<string, unknown>
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
        const update = (params.update && typeof params.update === 'object' ? params.update : {}) as Record<string, unknown>
        this.emit('update', { sessionId, update } satisfies AcpSessionUpdate)
      }
      return
    }

    // 2. Agent -> Client request
    if (method && hasId) {
      const rpcId = frame.id as number | string
      if (method === 'session/request_permission') {
        const params = (frame.params && typeof frame.params === 'object' ? frame.params : {}) as Record<string, unknown>
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
        const toolCall = (params.toolCall && typeof params.toolCall === 'object' ? params.toolCall : {}) as AcpPermissionRequest['toolCall']
        const rawOptions = Array.isArray(params.options) ? params.options : []
        const options: AcpPermissionOption[] = rawOptions
          .filter((o): o is Record<string, unknown> => Boolean(o && typeof o === 'object'))
          .map(o => ({
            optionId: String(o.optionId ?? ''),
            name: String(o.name ?? o.optionId ?? '允许'),
            ...(typeof o.kind === 'string' ? { kind: o.kind } : {})
          }))
          .filter(o => Boolean(o.optionId))
        let replied = false
        const respond = (outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }) => {
          if (replied) return
          replied = true
          this.writeFrame({ jsonrpc: '2.0', id: rpcId, result: { outcome } })
        }
        if (this.listenerCount('permission') > 0) {
          this.emit('permission', { rpcId, sessionId, toolCall, options, respond } satisfies AcpPermissionRequest)
        } else {
          respond({ outcome: 'cancelled' })
        }
        return
      }
      this.writeFrame({
        jsonrpc: '2.0',
        id: rpcId,
        error: { code: -32601, message: `Unsupported client method: ${method}` }
      })
      return
    }

    // 3. Response to an outgoing Client -> Agent request
    if (typeof frame.id !== 'number') return
    const item = this.pending.get(frame.id)
    if (!item) return
    if (item.timer) clearTimeout(item.timer)
    this.pending.delete(frame.id)
    if (frame.error && typeof frame.error === 'object') {
      const err = frame.error as { code?: number; message?: string; data?: unknown }
      const detail = err.data && typeof err.data === 'object' && typeof (err.data as { details?: unknown }).details === 'string'
        ? `（${(err.data as { details: string }).details}）`
        : ''
      if (err.code === -32000) {
        item.reject(new Error(this.authErrorMessage(err.message, detail)))
      } else {
        item.reject(new Error(`${err.message || `ACP 请求失败（${err.code ?? 'unknown'}）`}${detail}`))
      }
    } else {
      item.resolve(frame.result)
    }
  }

  /** 代理要求先认证（-32000）：内置预设给出对应 CLI 的登录命令；自定义代理优先展示它自己给的认证说明。 */
  private authErrorMessage(message: string | undefined, detail: string): string {
    if (this.launch.loginHint) return `ACP 需要先登录账号：请先在终端运行 ${this.launch.loginHint} 完成登录${detail}`
    const methods = (this.initResult?.authMethods ?? [])
      .map(m => [m.name, m.description].filter(Boolean).join('：'))
      .filter(Boolean)
    const own = [message?.trim(), detail.replace(/^（|）$/g, '').trim(), ...methods].filter(Boolean)
    return own.length
      ? `ACP 代理需要先完成认证：${[...new Set(own)].join('；')}`
      : 'ACP 代理需要先完成认证，请按该代理的说明登录后再连接。'
  }

  request(method: string, params: unknown = {}, timeout = 30_000): Promise<unknown> {
    const child = this.child
    if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) {
      return Promise.reject(new Error('ACP 服务尚未连接'))
    }
    const id = ++this.serial
    return new Promise((resolve, reject) => {
      const timer = timeout > 0
        ? setTimeout(() => {
            this.pending.delete(id)
            reject(new Error(`ACP 请求超时（${method}）`))
          }, timeout)
        : null
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        if (!error) return
        const item = this.pending.get(id)
        if (item) {
          if (item.timer) clearTimeout(item.timer)
          this.pending.delete(id)
          item.reject(new Error('ACP 输入通道已关闭'))
        }
      })
    })
  }

  notify(method: string, params: unknown = {}): void {
    this.writeFrame({ jsonrpc: '2.0', method, params })
  }

  newSession(cwd: string, mcpServers: AcpMcpServer[]): Promise<AcpSessionResult> {
    return this.request('session/new', { cwd, mcpServers }, 60_000) as Promise<AcpSessionResult>
  }

  /**
   * 按代理声明的能力恢复原会话：先 resume，失败再 load。两者都没声明返回 unsupported；
   * 声明了但请求报错返回 error。调用方据此决定保留原会话 ID 让用户重试，不能悄悄换成新会话。
   */
  async resumeOrLoadSession(sessionId: string, cwd: string, mcpServers: AcpMcpServer[]): Promise<AcpResumeResult> {
    const caps = this.initResult?.agentCapabilities
    const canResume = Boolean(caps?.sessionCapabilities?.resume)
    const canLoad = Boolean(caps?.loadSession || caps?.sessionCapabilities?.load)
    if (!canResume && !canLoad) return { status: 'unsupported' }
    let lastError: Error = new Error('恢复会话失败')
    if (canResume) {
      try {
        const res = await this.request('session/resume', { sessionId, cwd, mcpServers }, 30_000) as Partial<AcpSessionResult> | undefined
        return { status: 'resumed', session: { ...res, sessionId: res?.sessionId || sessionId } }
      } catch (error) { lastError = error instanceof Error ? error : new Error(String(error)) }
    }
    if (canLoad) {
      try {
        // session/load 会先把历史对话作为 session/update 回放，再返回结果；回放时没有进行中的轮次，宿主会丢弃这些通知
        const res = await this.request('session/load', { sessionId, cwd, mcpServers }, 60_000) as Partial<AcpSessionResult> | undefined
        return { status: 'resumed', session: { ...res, sessionId: res?.sessionId || sessionId } }
      } catch (error) { lastError = error instanceof Error ? error : new Error(String(error)) }
    }
    return { status: 'error', error: lastError }
  }

  /** 一轮对话可能要等用户审批很久，这里不设总时限；停止靠 session/cancel，代理不响应时由宿主结束连接。 */
  prompt(sessionId: string, prompt: AcpContentBlock[]): Promise<{ stopReason?: string; usage?: Record<string, unknown> }> {
    return this.request('session/prompt', { sessionId, prompt }, 0) as Promise<{
      stopReason?: string
      usage?: Record<string, unknown>
    }>
  }

  cancelSession(sessionId: string): void {
    if (!sessionId) return
    this.notify('session/cancel', { sessionId })
  }

  setModel(sessionId: string, modelId: string): Promise<unknown> {
    return this.request('session/set_model', { sessionId, modelId }, 15_000)
  }

  setMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.request('session/set_mode', { sessionId, modeId }, 15_000)
  }

  setConfigOption(sessionId: string, configId: string, value: string): Promise<{ configOptions?: AcpConfigOption[] } | undefined> {
    return this.request('session/set_config_option', { sessionId, configId, value }, 15_000) as Promise<{
      configOptions?: AcpConfigOption[]
    } | undefined>
  }

  closeSession(sessionId: string): Promise<unknown> {
    if (!sessionId || !this.initResult?.agentCapabilities?.sessionCapabilities?.close) return Promise.resolve()
    return this.request('session/close', { sessionId }, 2_000).catch(() => undefined)
  }

  /** 子进程 PID；进程已退出或还没启动时为 undefined。 */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /**
   * 结束子进程：先关输入等它自己退出，4 秒没退就强停整棵进程树。
   * 返回进程是否确实已经退出；强停命令也失败、进程还在时返回 false，调用方不能当作已结束。
   */
  async stop(activeSessionId?: string): Promise<boolean> {
    const child = this.child
    if (!child) return true
    if (activeSessionId) await this.closeSession(activeSessionId)
    try { child.stdin.end() } catch {}
    const exited = () => child.exitCode !== null || child.signalCode !== null
    const waitClose = (ms: number) => new Promise<boolean>(resolve => {
      if (exited()) { resolve(true); return }
      const timer = setTimeout(() => { child.off('close', onClose); resolve(exited()) }, ms)
      const onClose = () => { clearTimeout(timer); resolve(true) }
      child.once('close', onClose)
    })
    if (await waitClose(4_000)) return true
    await killTree(child)
    if (await waitClose(3_000)) return true
    if (process.platform !== 'win32') {
      try { child.kill('SIGKILL') } catch {}
      if (await waitClose(2_000)) return true
    }
    return false
  }
}
