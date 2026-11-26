#!/usr/bin/env node
// flying-draws / flying-draws-mcp：
// - 无参数或 --mcp：通过 stdio 启动轻量 MCP 桥接进程（stdout 严格只输出 MCP 协议帧）
// - setup / config / doctor / --help / --version：零门槛 CLI 配置向导与本地环境自检
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// FLYINGDRAWS_HOME 和桌面应用用的是同一个变量；桥接拉起应用时环境变量会传下去
const OVERRIDE_HOME = process.env.FLYINGDRAWS_HOME ? resolve(process.env.FLYINGDRAWS_HOME) : null
const HOME_DIR = OVERRIDE_HOME || join(homedir(), '.flyingdraws')
const DAEMON_INFO = join(HOME_DIR, 'daemon.json')
const APP_ROOT = resolve(__dirname, '..', '..')
const BRIDGE_ENTRY = resolve(__dirname, 'index.js')
const LAUNCH_TIMEOUT_MS = 30_000
const RELEASES_URL = 'https://github.com/jian-in/Flying-draws/releases'

const MCP_TOOL_NAMES = [
  'canvas_open',
  'canvas_list',
  'canvas_rename',
  'canvas_delete',
  'canvas_read',
  'canvas_request',
  'canvas_wait',
  'canvas_pass',
  'canvas_propose',
  'canvas_draw'
] as const

function readPackageVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as { version?: unknown }
    if (typeof raw.version === 'string' && raw.version.trim()) return raw.version.trim()
  } catch {}
  return '0.1.1'
}

const PKG_VERSION = readPackageVersion()

interface DaemonInfo {
  port: number
  token: string
}

interface DesktopLaunchTarget {
  command: string
  args: string[]
  source: 'env' | 'bundled-sibling' | 'repo-dist' | 'localappdata' | 'electron-dev'
  label: string
  windowsHide: boolean
}

type DesktopResolution =
  | { ok: true; target: DesktopLaunchTarget; notes: string[] }
  | { ok: false; error: string; notes: string[] }

const log = (...args: unknown[]) => console.error('[flying-draws-mcp]', ...args) // stdout 留给 MCP 协议

function readInfo(): DaemonInfo | null {
  try {
    const raw = JSON.parse(readFileSync(DAEMON_INFO, 'utf8')) as { port?: unknown; token?: unknown }
    if (
      !raw ||
      typeof raw !== 'object' ||
      typeof raw.port !== 'number' ||
      !Number.isInteger(raw.port) ||
      raw.port < 1 ||
      raw.port > 65535 ||
      typeof raw.token !== 'string' ||
      !raw.token.trim()
    ) {
      return null
    }
    return { port: raw.port, token: raw.token }
  } catch {
    return null
  }
}

// 用 node:http 而不是 fetch：fetch 在某些环境会读代理变量，本机请求不该走代理
function call(info: DaemonInfo, path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const isGet = path === '/health'
    const data = Buffer.from(JSON.stringify(body ?? {}))
    // GET 不能带 content-length：连接复用时服务端会把下一个请求的开头当成这次的请求体
    const headers: http.OutgoingHttpHeaders = { 'x-flyingdraws-token': info.token }
    if (!isGet) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = data.length
    }
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    const req = http.request(
      // signal：工具调用被取消时中止请求，画布那边看到连接断开就撤下这次等待
      { host: '127.0.0.1', port: info.port, path, method: isGet ? 'GET' : 'POST', headers, timeout: timeoutMs, signal },
      (res) => {
        const chunks: Buffer[] = []
        let ended = false
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('error', (err) => settle(() => reject(err)))
        res.on('end', () => {
          ended = true
          const raw = Buffer.concat(chunks).toString('utf8')
          let parsed: Record<string, unknown> = {}
          try {
            parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
          } catch {
            return settle(() => reject(new Error(`bad response from canvas app (HTTP ${res.statusCode}): ${raw.slice(0, 200)}`)))
          }
          if ((res.statusCode ?? 500) >= 400) settle(() => reject(new Error(String(parsed.error ?? `HTTP ${res.statusCode}`))))
          else settle(() => resolvePromise(parsed))
        })
        res.on('close', () => {
          if (!ended) settle(() => reject(new Error(`connection closed before response completed (${path})`)))
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error(`request to ${path} timed out`)))
    req.on('error', (err) => settle(() => reject(err)))
    if (!isGet) req.write(data)
    req.end()
  })
}

async function healthy(info: DaemonInfo | null): Promise<boolean> {
  if (!info) return false
  try {
    const res = await call(info, '/health', null, 1500)
    return res.ok === true && (res.pid === undefined || (typeof res.pid === 'number' && Number.isInteger(res.pid) && res.pid > 0))
  } catch {
    return false
  }
}

function tryResolveElectron(): string | null {
  try {
    // 在 Node 里加载 electron 包拿到的是 Electron 可执行文件的路径
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronPath = require('electron') as unknown
    if (typeof electronPath === 'string' && electronPath && existsSync(electronPath)) {
      return electronPath
    }
  } catch {}
  return null
}

function resolveDesktopLaunch(): DesktopResolution {
  const notes: string[] = []

  // 1) 环境变量 FLYINGDRAWS_APP 指定的桌面端可执行文件
  const envAppRaw = process.env.FLYINGDRAWS_APP?.trim()
  if (envAppRaw) {
    const envApp = resolve(envAppRaw)
    if (existsSync(envApp)) {
      return {
        ok: true,
        notes,
        target: {
          command: envApp,
          args: [],
          source: 'env',
          label: `FLYINGDRAWS_APP (${envApp})`,
          windowsHide: true
        }
      }
    }
    return {
      ok: false,
      notes,
      error:
        `FLYINGDRAWS_APP points to a missing executable: ${envApp}. ` +
        `Update FLYINGDRAWS_APP to a valid "Flying draws.exe" path or unset it.`
    }
  }

  // 2) 独立目录包同级 ../../Flying draws.exe（自带 Electron，不依赖开发环境的 electron 包）
  const bundledSibling = resolve(APP_ROOT, '..', '..', 'Flying draws.exe')
  if (existsSync(bundledSibling)) {
    return {
      ok: true,
      notes,
      target: {
        command: bundledSibling,
        args: [],
        source: 'bundled-sibling',
        label: `bundled executable (${bundledSibling})`,
        windowsHide: true
      }
    }
  }

  const outMain = join(APP_ROOT, 'out', 'main', 'index.js')
  const outMainExists = existsSync(outMain)
  const devElectron = tryResolveElectron()
  const isIsolatedDebug = Boolean(process.env.FLYINGDRAWS_DEBUG_PORT)

  // 3) 仓库 dist/Flying-draws-win32-x64/Flying draws.exe 或 %LOCALAPPDATA%/Flying draws/Flying draws.exe
  const distCandidates = Array.from(
    new Set([
      join(APP_ROOT, 'dist', 'Flying-draws-win32-x64', 'Flying draws.exe'),
      join(APP_ROOT, 'dist', `Flying-draws-${process.platform}-${process.arch}`, 'Flying draws.exe')
    ])
  )
  for (const distExe of distCandidates) {
    if (!existsSync(distExe)) continue
    const distMain = join(dirname(distExe), 'resources', 'app', 'out', 'main', 'index.js')
    const staleInDevRepo =
      Boolean(devElectron) &&
      outMainExists &&
      (isIsolatedDebug || (existsSync(distMain) && statSync(distMain).mtimeMs + 1000 < statSync(outMain).mtimeMs))
    if (staleInDevRepo) {
      notes.push(`Skipped older dist bundle (${distExe}) in favor of fresher out/main/index.js`)
      continue
    }
    return {
      ok: true,
      notes,
      target: {
        command: distExe,
        args: [],
        source: 'repo-dist',
        label: `repo dist bundle (${distExe})`,
        windowsHide: true
      }
    }
  }

  const localAppData =
    process.env.LOCALAPPDATA?.trim() || (process.platform === 'win32' ? join(homedir(), 'AppData', 'Local') : '')
  if (localAppData && !isIsolatedDebug) {
    const localAppExe = join(localAppData, 'Flying draws', 'Flying draws.exe')
    if (existsSync(localAppExe)) {
      return {
        ok: true,
        notes,
        target: {
          command: localAppExe,
          args: [],
          source: 'localappdata',
          label: `%LOCALAPPDATA% bundle (${localAppExe})`,
          windowsHide: true
        }
      }
    }
  }

  // 4) 开发环境 electron 包 + 构建产物 out/main/index.js
  if (!devElectron) {
    return {
      ok: false,
      notes,
      error:
        `Flying draws desktop executable not found (and local "electron" package is not installed).\n` +
        `How to fix:\n` +
        `  1. Download Flying-draws-win32-x64.zip from GitHub Releases (${RELEASES_URL}), unpack it, and set FLYINGDRAWS_APP="<path>\\Flying draws.exe" (or place it in %LOCALAPPDATA%\\Flying draws\\Flying draws.exe); OR\n` +
        `  2. In the repository (${APP_ROOT}), run "npm install && npm run build".`
    }
  }

  if (!outMainExists) {
    return {
      ok: false,
      notes,
      error: `Flying draws is not built yet. Run "npm run build" in ${APP_ROOT} first, or set FLYINGDRAWS_APP to a packaged "Flying draws.exe".`
    }
  }

  return {
    ok: true,
    notes,
    target: {
      command: devElectron,
      args: [APP_ROOT],
      source: 'electron-dev',
      label: `development Electron (${devElectron})`,
      windowsHide: false
    }
  }
}

function launchApp(): { child: ReturnType<typeof spawn>; source: DesktopLaunchTarget['source'] } {
  const resolved = resolveDesktopLaunch()
  if (!resolved.ok) {
    throw new Error(resolved.error)
  }
  const { target } = resolved
  const env = { ...process.env }
  if (OVERRIDE_HOME) env.FLYINGDRAWS_HOME = OVERRIDE_HOME
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(target.command, target.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: target.windowsHide,
    env
  })
  child.on('error', (err) => log(`Could not start Flying draws (${target.source}):`, err.message))
  child.unref()
  log('launched canvas app via', target.source, 'pid', child.pid)
  return { child, source: target.source }
}

function resolveFuxiBinary(desktopResolution: DesktopResolution): string | null {
  const fuxiName = process.platform === 'win32' ? 'fuxi.exe' : 'fuxi'
  const override = process.env.FLYINGDRAWS_FUXI_BIN?.trim()
  if (override) {
    const resolvedOverride = resolve(override)
    return existsSync(resolvedOverride) ? resolvedOverride : null
  }
  const candidates = [
    resolve(APP_ROOT, '..', 'fuxi', fuxiName),
    join(APP_ROOT, 'resources', 'fuxi', fuxiName)
  ]
  if (desktopResolution.ok && desktopResolution.target.source !== 'electron-dev') {
    candidates.unshift(join(dirname(desktopResolution.target.command), 'resources', 'fuxi', fuxiName))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

type SetupClient = 'claude' | 'cursor' | 'codex' | 'antigravity'

function formatSetupOutput(target: SetupClient | 'all', jsonOnly: boolean): string {
  const bridgePath = BRIDGE_ENTRY.replace(/\\/g, '/')
  const envApp = process.env.FLYINGDRAWS_APP?.trim()
  const envBlock = envApp ? { FLYINGDRAWS_APP: resolve(envApp).replace(/\\/g, '/') } : undefined
  const mcpServerEntry: Record<string, unknown> = {
    command: 'node',
    args: [bridgePath],
    ...(envBlock ? { env: envBlock } : {})
  }
  const jsonConfig = JSON.stringify({ mcpServers: { 'flying-draws': mcpServerEntry } }, null, 2)
  if (jsonOnly) return jsonConfig

  const sections: Record<SetupClient, string> = {
    claude: [
      '=== Claude Code ===',
      `# 一行命令直接注册（推荐）：`,
      envBlock
        ? `claude mcp add --scope user -e FLYINGDRAWS_APP="${envBlock.FLYINGDRAWS_APP}" flying-draws -- node "${bridgePath}"`
        : `claude mcp add --scope user flying-draws -- node "${bridgePath}"`,
      '',
      '# 或写入项目根目录 .mcp.json：',
      jsonConfig
    ].join('\n'),
    cursor: [
      '=== Cursor ===',
      '# 写入 ~/.cursor/mcp.json 或项目 .cursor/mcp.json：',
      jsonConfig
    ].join('\n'),
    codex: [
      '=== Codex ===',
      '# 一行命令直接注册：',
      `codex mcp add flying-draws -- node "${bridgePath}"`,
      '',
      '# 或写入 ~/.codex/config.toml：',
      '[mcp_servers.flying-draws]',
      'command = "node"',
      `args = ["${bridgePath}"]`,
      ...(envBlock ? ['[mcp_servers.flying-draws.env]', `FLYINGDRAWS_APP = "${envBlock.FLYINGDRAWS_APP}"`] : [])
    ].join('\n'),
    antigravity: [
      '=== Antigravity ===',
      '# 写入 mcp_config.json：',
      jsonConfig
    ].join('\n')
  }

  if (target !== 'all') {
    return sections[target]
  }

  return [
    `Flying draws v${PKG_VERSION} — MCP 30 秒零门槛接入配置`,
    `Bridge path: ${bridgePath}`,
    '',
    sections.claude,
    '',
    sections.cursor,
    '',
    sections.codex,
    '',
    sections.antigravity,
    '',
    `自检命令：node "${bridgePath}" doctor`
  ].join('\n')
}

function parseNodeVersionOk(ver: string): boolean {
  const [major = 0, minor = 0] = ver.split('.').map((n) => Number.parseInt(n, 10))
  return major > 20 || (major === 20 && minor >= 19)
}

async function runDoctor(): Promise<string> {
  const lines: string[] = [`Flying draws v${PKG_VERSION} — 环境自检 (doctor)`, '']

  // 1. Node.js 版本
  const nodeVer = process.versions.node
  const nodeOk = parseNodeVersionOk(nodeVer)
  lines.push(
    nodeOk
      ? `[OK]   Node.js: v${nodeVer} (满足 >= 20.19.0)`
      : `[WARN] Node.js: v${nodeVer} (建议使用 Node.js >= 20.19.0)`
  )

  // 2. 构建产物检测
  const outMain = join(APP_ROOT, 'out', 'main', 'index.js')
  const outRenderer = join(APP_ROOT, 'out', 'renderer', 'index.html')
  const hasBuild = existsSync(outMain) && existsSync(outRenderer)
  lines.push(
    hasBuild
      ? `[OK]   构建产物: 已就绪 (${outMain})`
      : `[INFO] 构建产物: 未检测到完整本地构建 (${outMain})；若使用独立桌面包可忽略，源码运行请执行 npm run build`
  )

  // 3. 画布桌面端可执行文件寻址
  const desktop = resolveDesktopLaunch()
  if (desktop.ok) {
    lines.push(`[OK]   桌面画布端: ${desktop.target.label}`)
  } else {
    lines.push(`[WARN] 桌面画布端: 未找到可用启动路径 — ${desktop.error.replace(/\n+/g, ' ')}`)
  }
  for (const note of desktop.notes) {
    lines.push(`       └─ ${note}`)
  }

  // 4. ~/.flyingdraws/daemon.json 在线状态
  const info = readInfo()
  const isOnline = await healthy(info)
  if (isOnline && info) {
    lines.push(`[OK]   本地画布服务: 在线 (127.0.0.1:${info.port}, ${DAEMON_INFO})`)
  } else {
    lines.push(`[INFO] 本地画布服务: 当前未运行 (${DAEMON_INFO}) — 首次调用 MCP 工具时将自动拉起画布窗口`)
  }

  // 5. 内置 Fuxi 内核检测（可选）
  const fuxiPath = resolveFuxiBinary(desktop)
  if (fuxiPath) {
    lines.push(`[OK]   内置 Fuxi 内核: 已安装 (${fuxiPath})`)
  } else {
    lines.push(
      `[INFO] 内置 Fuxi 内核: 未安装（提示：未安装 Fuxi 时外部 MCP 画布全部 ${MCP_TOOL_NAMES.length} 个工具仍 100% 可用！）`
    )
  }

  lines.push('')
  lines.push(`外部 MCP 工具 (${MCP_TOOL_NAMES.length} 个): ${MCP_TOOL_NAMES.join(', ')}`)
  return lines.join('\n')
}

function formatHelp(): string {
  const bridgePath = BRIDGE_ENTRY.replace(/\\/g, '/')
  return [
    `Flying draws v${PKG_VERSION} — Spatial memory, visual diff & live proposal pad for coding agents`,
    '',
    'Usage:',
    '  flying-draws [--mcp]                              Start stdio MCP server (default when no args are given)',
    '  flying-draws setup [claude|cursor|codex|antigravity] [--json]',
    '                                                    Print copy-paste MCP registration command / JSON config',
    '  flying-draws config [client]                      Alias for "setup"',
    '  flying-draws doctor                               Inspect Node, build artifacts, desktop app, daemon & Fuxi status',
    '  flying-draws call <tool> [json|@file|-] [--as <seat>] [--agent <name>]',
    '                                                    Call one canvas tool from a shell (for agents without MCP) and print the result',
    '  flying-draws call --list                          List the canvas tool names',
    '  flying-draws --version, -v                        Print version',
    '  flying-draws --help, -h                           Show this help message',
    '',
    'Environment variables:',
    '  FLYINGDRAWS_APP    Path to standalone "Flying draws.exe" (highest launch priority)',
    '  FLYINGDRAWS_HOME   Custom state & boards directory (default: ~/.flyingdraws)',
    '  FLYINGDRAWS_SEAT   Default collaborative agent seat name',
    '',
    `Quick start: node "${bridgePath}" setup`
  ].join('\n')
}

function isCliMode(args: readonly string[]): boolean {
  if (args.length === 0) return false
  if (args.length === 1 && args[0] === '--mcp') return false
  return true
}

async function runCli(args: readonly string[]): Promise<never> {
  const cmd = args[0]
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    process.stdout.write(`flying-draws ${PKG_VERSION}\n`)
    process.exit(0)
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(`${formatHelp()}\n`)
    process.exit(0)
  }
  if (cmd === 'setup' || cmd === 'config') {
    const rest = args.slice(1)
    const jsonOnly = rest.includes('--json')
    const positional = rest.filter((a) => !a.startsWith('-'))
    const rawTarget = (positional[0] ?? 'all').toLowerCase()
    const normalizedTarget: SetupClient | 'all' | null =
      rawTarget === 'all'
        ? 'all'
        : rawTarget === 'claude' || rawTarget === 'claude-code'
          ? 'claude'
          : rawTarget === 'cursor'
            ? 'cursor'
            : rawTarget === 'codex'
              ? 'codex'
              : rawTarget === 'antigravity'
                ? 'antigravity'
                : null
    if (!normalizedTarget) {
      process.stderr.write(
        `Unknown client "${positional[0]}". Supported clients: claude, cursor, codex, antigravity.\n`
      )
      process.exit(1)
    }
    process.stdout.write(`${formatSetupOutput(normalizedTarget, jsonOnly)}\n`)
    process.exit(0)
  }
  if (cmd === 'doctor') {
    const report = await runDoctor()
    process.stdout.write(`${report}\n`)
    process.exit(0)
  }
  if (cmd === 'call') {
    process.exit(await runCall(args.slice(1)))
  }
  process.stderr.write(`Unknown command "${cmd}". Run with --help for usage.\n`)
  process.exit(1)
}

let launching: Promise<DaemonInfo> | null = null

async function ensureDaemon(): Promise<DaemonInfo> {
  const info = readInfo()
  if (await healthy(info)) return info!
  if (!launching) {
    launching = (async () => {
      const { child, source } = launchApp()
      let launchFailure: Error | null = null
      let wake: (() => void) | null = null
      const onError = (err: Error) => {
        launchFailure = new Error(`Could not start Flying draws (${source}): ${err.message}`)
        wake?.()
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        // 第二个实例没抢到单实例锁会以 code 0 正常退出，此时继续轮询等待主实例就绪
        if (code === 0 && !signal) return
        launchFailure = new Error(
          `Flying draws (${source}) exited before becoming ready (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`})`
        )
        wake?.()
      }
      child.once('error', onError)
      child.once('exit', onExit)
      try {
        const deadline = Date.now() + LAUNCH_TIMEOUT_MS
        while (Date.now() < deadline) {
          if (!launchFailure) {
            await new Promise<void>((r) => {
              const t = setTimeout(() => { wake = null; r() }, 400)
              wake = () => { clearTimeout(t); wake = null; r() }
            })
          }
          const fresh = readInfo()
          if (await healthy(fresh)) return fresh!
          if (launchFailure) throw launchFailure
        }
        throw new Error('Flying draws canvas app did not start within 30s')
      } finally {
        child.off('error', onError)
        child.off('exit', onExit)
      }
    })().finally(() => {
      launching = null
    })
  }
  return launching
}

const BRIDGE_ID = randomUUID()

async function daemon(path: string, body: unknown, timeoutMs = 15_000, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const info = await ensureDaemon()
  const agent = clientAgentName()
  const payload =
    body && typeof body === 'object' && !Array.isArray(body)
      ? {
          bridge_id: BRIDGE_ID,
          ...(agent && !('agent' in body) ? { agent } : {}),
          ...(sessionSeat && !('as' in body) ? { as: sessionSeat } : {}),
          ...(body as Record<string, unknown>)
        }
      : body
  return call(info, path, payload, timeoutMs, signal)
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

// 把本地服务返回的画板描述转成 MCP 内容：文字描述 + 可选的结构 JSON + 可选的截图
function boardContent(res: Record<string, unknown>, header?: string): Content[] {
  const parts: string[] = []
  if (header) parts.push(header)
  parts.push(String(res.summary ?? ''))
  if (res.graph) parts.push(`结构（JSON）：\n${JSON.stringify(res.graph)}`)
  const content: Content[] = [{ type: 'text', text: parts.join('\n\n') }]
  if (typeof res.image_png_base64 === 'string' && res.image_png_base64) {
    content.push({ type: 'image', data: res.image_png_base64, mimeType: 'image/png' })
  }
  return content
}

const text = (t: string): { content: Content[] } => ({ content: [{ type: 'text', text: t }] })

async function guarded(fn: () => Promise<{ content: Content[] }>): Promise<{ content: Content[]; isError?: boolean }> {
  try {
    return await fn()
  } catch (err) {
    return { content: [{ type: 'text', text: `Flying draws error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
  }
}

const formatSchema = z
  .enum(['summary', 'graph'])
  .optional()
  .describe('"summary" (default): a short text description. "graph": also include the structured JSON (nodes, edges, notes, strokes).')
const imageSchema = z
  .enum(['auto', 'always', 'never'])
  .optional()
  .describe('Attach a PNG of the canvas. "auto" (default) attaches it only when the drawing has things the text description cannot capture (scribbles, images, plain lines).')
const boardSchema = z
  .string()
  .min(1)
  .optional()
  .describe('Optional board id/name (e.g. "default", "login-flow"). Omit to use the currently active board.')
const asSchema = z
  .string()
  .min(1)
  .optional()
  .describe('Optional seat/author name for collaborative drawing (e.g. "architect", "reviewer"). Gives your drawings a distinct color and seat tag; remembered for subsequent calls in this session.')

let sessionSeat: string | undefined = process.env.FLYINGDRAWS_SEAT?.trim() || undefined
const rememberSeat = (as: string | undefined): string | undefined => {
  if (as && as.trim()) sessionSeat = as.trim()
  return sessionSeat
}

const server = new McpServer({ name: 'flying-draws', version: PKG_VERSION })
const clientAgentName = (): string | undefined => server.server.getClientVersion()?.name?.trim() || undefined

// 桌面应用开着时主动报个到，不自动拉起应用；退出时通知主进程撤下在线席位
function announceSeat(leave = false): Promise<void> {
  const info = readInfo()
  if (!info) return Promise.resolve()
  const agent = clientAgentName()
  return call(
    info,
    '/seat',
    {
      bridge_id: BRIDGE_ID,
      ...(agent ? { agent } : {}),
      ...(sessionSeat ? { as: sessionSeat } : {}),
      ...(leave ? { leave: true } : {})
    },
    leave ? 500 : 1000
  )
    .then(() => undefined)
    .catch(() => undefined)
}

server.registerTool(
  'canvas_open',
  {
    title: 'Open or create a Flying draws canvas board',
    description:
      'Open the local Flying draws drawing canvas window (starting the app if needed) and bring it to the front. ' +
      'Optionally pass "board" to switch to another board or create a new blank board if it does not exist yet.',
    inputSchema: {
      board: z.string().min(1).optional().describe('Optional board id/name to open or create. Omit to open the current active board.'),
      title: z.string().min(1).optional().describe('Optional human-readable title when creating or naming a board.'),
      as: asSchema
    }
  },
  ({ board, title, as }) => guarded(async () => {
    const res = await daemon('/open', { board, title, as: rememberSeat(as) })
    const action = res.created ? 'Created and opened canvas' : 'Canvas'
    const label = res.title ? `${res.board}" ("${res.title}")` : `${res.board}"`
    return text(`${action} "${label} is open (version ${res.version}). The user can draw on it now.`)
  })
)

server.registerTool(
  'canvas_list',
  {
    title: 'List Flying draws canvas boards',
    description: 'List all available boards in Flying draws, showing which one is currently active, its title, version, and element count.',
    inputSchema: { as: asSchema },
    annotations: { readOnlyHint: true }
  },
  ({ as }) => guarded(async () => {
    const res = await daemon('/list', { as: rememberSeat(as) })
    const boards = (Array.isArray(res.boards) ? res.boards : []) as {
      board: string
      title: string | null
      version: number
      elements: number
      active: boolean
    }[]
    if (!boards.length) return text('No boards yet.')
    const lines = boards.map((b) => {
      const mark = b.active ? ' [active]' : ''
      const title = b.title ? ` "${b.title}"` : ''
      return `- ${b.board}${title}${mark}: v${b.version}, ${b.elements} element(s)`
    })
    return text(`Current board: ${res.current}\n${lines.join('\n')}`)
  })
)

server.registerTool(
  'canvas_rename',
  {
    title: 'Rename a Flying draws canvas board',
    description: 'Rename an existing board and/or update its display title. Preserves the active session and undo history.',
    inputSchema: {
      board: z.string().min(1).optional().describe('Board id to rename. Omit to rename the current active board.'),
      new_board: z.string().min(1).describe('New board id/name.'),
      title: z.string().nullable().optional().describe('Optional display title. Pass null to clear the existing title.')
    }
  },
  ({ board, new_board, title }) => guarded(async () => {
    const res = await daemon('/rename', { board, new_board, title })
    const label = res.title ? `${res.board}" ("${res.title}")` : `${res.board}"`
    return text(`Renamed board "${res.old_board}" to "${label} (v${res.version}).`)
  })
)

server.registerTool(
  'canvas_delete',
  {
    title: 'Delete a Flying draws canvas board',
    description:
      'Delete a board from Flying draws and remove its .excalidraw file. Cannot delete the last remaining board. ' +
      'If deleting the active board, Flying draws automatically switches to another board.',
    inputSchema: {
      board: z.string().min(1).optional().describe('Board id to delete. Omit to delete the current active board.')
    }
  },
  ({ board }) => guarded(async () => {
    const res = await daemon('/delete', { board })
    const currentLabel = res.title ? `${res.current}" ("${res.title}")` : `${res.current}"`
    return text(`Deleted board "${res.deleted}". Current active board is now "${currentLabel} (v${res.version}).`)
  })
)

server.registerTool(
  'canvas_read',
  {
    title: 'Read the canvas',
    description:
      'Read what is currently drawn on the Flying draws canvas. Returns a description of nodes (boxes with their text, id like N1), ' +
      'arrows between them, free text notes (id like T1) and where they sit, and hand-drawn strokes/groups (id like S1). ' +
      'The first line shows the canvas version (e.g. v12). Element ids (N1, T1, S1) are valid only for that version. Use this right away when the user says they drew something, sent you the canvas, or refers to "the canvas" / "my sketch": ' +
      'the canvas cannot notify you by itself, so a drawing the user sent just waits until you read it.',
    inputSchema: { board: boardSchema, format: formatSchema, image: imageSchema, as: asSchema },
    // Reading only hands over what the user already sent; it never edits a board.
    // Lets an agent's read-only planning look at the canvas.
    annotations: { readOnlyHint: true }
  },
  ({ board, format, image, as }) => guarded(async () => {
    const res = await daemon('/read', { board, format: format ?? 'summary', image: image ?? 'auto', as: rememberSeat(as) }, 20_000)
    // 用户之前主动点过"发给 agent"的，以及别的席位递过来的画笔，这次读取一并交给 agent
    const sent = (Array.isArray(res.sent) ? res.sent : []) as { note: string }[]
    const handoffs = (Array.isArray(res.handoffs) ? res.handoffs : []) as { from: string; note: string }[]
    const headers: string[] = []
    if (sent.length) {
      const notes = sent.map((s) => s.note).filter(Boolean)
      headers.push(
        `The user pressed "Send to agent" on the canvas${notes.length ? ` with this note: ${notes.map((n) => `"${n}"`).join(' / ')}` : ' (no note)'}.`
      )
    }
    for (const h of handoffs) {
      headers.push(`Agent "${h.from}" passed the brush to you${h.note ? `: "${h.note}"` : ''}.`)
    }
    const header = headers.length ? `${headers.join(' ')} This is the canvas now:` : undefined
    return { content: boardContent(res, header) }
  })
)

server.registerTool(
  'canvas_request',
  {
    title: 'Ask the user to draw',
    description:
      'Ask the user to draw or sketch something on the canvas, when an idea is easier to show than to type ' +
      '(a layout, a flow, a rough shape, positions, a curve). Shows your prompt on the canvas and returns a request_id immediately. ' +
      'Then call canvas_wait with that request_id to get the drawing.',
    inputSchema: {
      prompt: z.string().min(1).describe('What you want the user to draw, in the user\'s language. Shown on the canvas.'),
      board: boardSchema,
      as: asSchema
    }
  },
  ({ prompt, board, as }) => guarded(async () => {
    const res = await daemon('/request', { prompt, board, as: rememberSeat(as) })
    return text(
      `Request ${res.request_id} is shown on the canvas "${res.board}". Now call canvas_wait with request_id "${res.request_id}" to receive the drawing.`
    )
  })
)

server.registerTool(
  'canvas_wait',
  {
    title: 'Wait for the user\'s drawing or another seat\'s handoff',
    description:
      'Wait until the user presses "Send" on the canvas or another agent seat passes the brush via canvas_pass, for at most timeout_s seconds (max 45). ' +
      'With request_id: waits for the answer to that canvas_request or canvas_propose. Without it: waits for the user to send the canvas or another seat to pass the brush to you. ' +
      'If the result says still waiting, call canvas_wait again. After about 3 empty waits, stop and tell the user in the chat instead of retrying silently.',
    inputSchema: {
      request_id: z.string().optional().describe('The id returned by canvas_request or canvas_propose.'),
      board: boardSchema,
      as: asSchema,
      timeout_s: z.number().int().min(1).max(45).optional().describe('How long to wait, in seconds. Default 40.'),
      format: formatSchema,
      image: imageSchema
    }
  },
  ({ request_id, board, as, timeout_s, format, image }, extra) => guarded(async () => {
    const wait = timeout_s ?? 40
    const res = await daemon('/wait', { request_id, board, as: rememberSeat(as), timeout_s: wait, format: format ?? 'summary', image: image ?? 'auto' }, (wait + 10) * 1000, extra.signal)
    switch (res.status) {
      case 'submitted': {
        const note = res.note ? `The user's note: "${res.note}"` : 'The user added no note.'
        if (res.decision === 'accepted') {
          const changes = Array.isArray(res.changes) ? (res.changes as string[]) : null
          const edits =
            changes === null
              ? 'They may have adjusted it first, so read the canvas below rather than assuming it matches what you drew.'
              : changes.length === 0
                ? 'They accepted it exactly as you drew it.'
                : `Before accepting, the user changed it. Treat these edits as corrections to your understanding:\n${changes.map((c) => `- ${c}`).join('\n')}\n`
          return { content: boardContent(res, `The user ACCEPTED your proposal. It is now part of the canvas. ${edits} ${note}`) }
        }
        if (res.decision === 'rejected') {
          return { content: boardContent(res, `The user REJECTED your proposal and it was removed from the canvas. ${note}`) }
        }
        return { content: boardContent(res, `The user sent the canvas. ${note}`) }
      }
      case 'handoff':
        return {
          content: boardContent(
            res,
            `Agent "${res.from}" passed the brush to you${res.note ? ` with note: "${res.note}"` : ''}. This is the canvas now:`
          )
        }
      case 'waiting':
        return text(`The user has not sent anything yet (still drawing). Call canvas_wait again${request_id ? ` with request_id "${request_id}"` : ''}.`)
      case 'cancelled':
        return text('The user dismissed this drawing request. Continue in the chat instead.')
      case 'unknown_request':
        return text(`Unknown request_id "${request_id}". The canvas app may have restarted; call canvas_request again.`)
      default:
        return text(JSON.stringify(res))
    }
  })
)

server.registerTool(
  'canvas_pass',
  {
    title: 'Pass the brush to another agent seat',
    description:
      'Hand off the canvas to another agent seat (or any other waiting seat if "to" is omitted) with a note explaining what to do next. ' +
      'If the target seat is already waiting via canvas_wait, it receives your snapshot and note immediately; otherwise the handoff waits on the board until that seat calls canvas_wait or canvas_read.',
    inputSchema: {
      board: boardSchema,
      as: asSchema,
      to: z.string().min(1).optional().describe('Target seat name (e.g. "reviewer"). Omit to pass to any other seat.'),
      note: z.string().min(1).describe('Instructions or context for the next agent.')
    }
  },
  ({ board, as, to, note }) => guarded(async () => {
    const res = await daemon('/pass', { board, as: rememberSeat(as), to, note })
    const target = res.to ? `seat "${res.to}"` : 'the next seat'
    if (res.status === 'delivered') {
      return text(`Passed the brush from "${res.from}" directly to waiting ${target} on board "${res.board}" (v${res.version}).`)
    }
    return text(`Handoff from "${res.from}" to ${target} is queued on board "${res.board}" (v${res.version}). It will be delivered when they call canvas_wait or canvas_read.`)
  })
)

const existingNode = 'An existing node id like "N1" from your latest canvas_read.'
const existingText = 'An existing free text id like "T1" from your latest canvas_read.'
const existingStrokes = 'An existing hand-drawn stroke or stroke group id like "S1" from your latest canvas_read.'
const moveCoord = z.number().min(-1_000_000).max(1_000_000)
const modifyOps = [
  z
    .object({
      op: z.literal('move'),
      id: z
        .string()
        .trim()
        .min(1)
        .describe(
          'Target element to move: node ("N1"), free text ("T1"), stroke/stroke-group ("S1"), image ("I1"), or stable element id. Connected arrows follow automatically (image annotations are separate elements and stay unless moved explicitly).'
        ),
      x: moveCoord.optional().describe('Mode 1 (exact top-left canvas position, pair with y): new left coordinate of the element bounding box.'),
      y: moveCoord.optional().describe('Mode 1 (pair with x): new top coordinate of the element bounding box.'),
      dx: moveCoord.optional().describe('Mode 2 (relative pixel shift, give dx and/or dy): horizontal shift in px (positive = right).'),
      dy: moveCoord.optional().describe('Mode 2 (give dx and/or dy): vertical shift in px (positive = down).'),
      near: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('Mode 3 (semantic placement, best when reading summary without coordinates): place beside another element id ("N1", "I1", or a new add_node id in this same call), automatically avoiding obstacles.'),
      side: z.enum(['right', 'left', 'below', 'above']).optional().describe('Used with "near": which side of the anchor to place on (default "right").'),
      gap: z.number().min(0).max(400).optional().describe('Used with "near": spacing in px from the anchor (default 40).')
    })
    .strict(),
  z.object({ op: z.literal('update_node'), id: z.string().min(1).describe(existingNode), label: z.string().describe('The new text inside the node. Long text automatically widens/grows the node from its center unless explicit width/height is set via set_style.') }),
  z.object({
    op: z.literal('delete_node'),
    id: z.string().min(1).describe(existingNode + ' Arrows drawn by agents that touch it are deleted with it.')
  }),
  z.object({
    op: z.literal('update_edge'),
    from: z.string().min(1).describe(existingNode),
    to: z.string().min(1).describe(existingNode),
    label: z.string().describe('The new text on the arrow. Empty string removes it.')
  }),
  z.object({ op: z.literal('delete_edge'), from: z.string().min(1).describe(existingNode), to: z.string().min(1).describe(existingNode) }),
  z.object({ op: z.literal('update_text'), id: z.string().min(1).describe(existingText), text: z.string().min(1).describe('The new text content.') }),
  z.object({ op: z.literal('delete_text'), id: z.string().min(1).describe(existingText) }),
  z.object({ op: z.literal('delete_strokes'), id: z.string().min(1).describe(existingStrokes) }),
  z.object({
    op: z.literal('set_style'),
    id: z.string().min(1).optional().describe('Target element id: a node ("N1"), text ("T1"), or stroke ("S1").'),
    from: z.string().min(1).optional().describe('Start node id when styling an arrow instead of passing "id".'),
    to: z.string().min(1).optional().describe('End node id when styling an arrow instead of passing "id".'),
    color: z.string().optional().describe('Stroke and text color as hex, e.g. "#e03131".'),
    fill: z.string().optional().describe('Background fill color as hex (e.g. "#ffec99"), or "transparent" (nodes only).'),
    shape: z.enum(['rectangle', 'ellipse', 'diamond']).optional().describe('New shape (rectangle/ellipse/diamond nodes only).'),
    width: z.number().optional().describe('New width in px (20-4000), centered on current position (nodes only).'),
    height: z.number().optional().describe('New height in px (20-4000), centered on current position (nodes only).')
  })
] as const

const addOps = [
  z.object({
    op: z.literal('add_node'),
    id: z.string().min(1).describe('A name you choose for this new node (e.g. "login"), used by add_edge / add_text in the same call. Must not look like an existing node id.'),
    label: z.string().optional().describe('Text inside the node.'),
    shape: z.enum(['rectangle', 'ellipse', 'diamond']).optional().describe('Default rectangle. Use diamond for decisions.'),
    x: z.number().optional().describe('Usually omit x and y: the canvas places new nodes in free space.'),
    y: z.number().optional()
  }),
  z.object({
    op: z.literal('add_edge'),
    from: z.string().min(1).describe('Id of a node added in this call, or an existing node id like "N1" from your latest canvas_read.'),
    to: z.string().min(1),
    label: z.string().optional().describe('Text on the arrow.')
  }),
  z.object({
    op: z.literal('add_text'),
    text: z.string().min(1),
    near: z.string().optional().describe('Put the text just below this node (new id or existing id like "N1").'),
    x: z.number().optional(),
    y: z.number().optional()
  })
] as const

// 照图还原：坐标都在 space 坐标系里（通常就是原图像素），画布负责换算，不用算画布坐标
const tracePoint = z.tuple([z.number(), z.number()])
const traceElement = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('box'),
    id: z.string().min(1).optional().describe('Name this box so lines can attach to it with from/to.'),
    x: z.number().describe('Left edge in the image coordinate space.'),
    y: z.number().describe('Top edge.'),
    w: z.number().positive(),
    h: z.number().positive(),
    shape: z.enum(['rectangle', 'ellipse', 'diamond']).optional(),
    label: z.string().optional().describe('Text inside the box, exactly as written in the image.'),
    color: z.string().optional().describe('Border and text color as hex, e.g. "#1971c2".'),
    fill: z.string().optional().describe('Fill color as hex, or "transparent".'),
    font_size: z.number().positive().optional().describe('Text height in the image coordinate space.')
  }),
  z.object({
    kind: z.literal('text'),
    x: z.number().describe('Left edge of the text.'),
    y: z.number().describe('Top edge of the text.'),
    text: z.string().min(1),
    color: z.string().optional(),
    font_size: z.number().positive().optional()
  }),
  z.object({
    kind: z.literal('line'),
    points: z.array(tracePoint).min(2).max(200).describe('The polyline in the image coordinate space: [[x, y], [x, y], ...].'),
    arrow: z.enum(['none', 'end', 'start', 'both']).optional().describe('Arrowheads; default none.'),
    color: z.string().optional(),
    dashed: z.boolean().optional(),
    from: z.string().optional().describe('Id of the box where the line starts, so it stays attached when the box moves.'),
    to: z.string().optional().describe('Id of the box where the line ends.')
  })
])
const traceOp = z.object({
  op: z.literal('trace_image'),
  image: z.string().min(1).describe('Image id from canvas_read (like "I1"), or the image\'s stable element id.'),
  space: z
    .object({ w: z.number().positive().max(20000), h: z.number().positive().max(20000) })
    .describe('The coordinate space of all x/y/w/h/points below, usually the image\'s pixel size. The canvas scales it onto the image.'),
  place: z.enum(['beside', 'over']).optional().describe('"beside" (default): a same-size copy next to the image; "over": on top of the image.'),
  elements: z.array(traceElement).min(1).max(500).describe('Every box, text and line you see in the image, with positions, colors and text as in the image.')
})

const drawOpSchema = z.discriminatedUnion('op', [...addOps, ...modifyOps, traceOp])

const directionSchema = z
  .enum(['right', 'down'])
  .optional()
  .describe('Which way the new nodes flow: "right" (default, left to right) or "down" (top to bottom).')
const baseVersionSchema = z
  .number()
  .int()
  .optional()
  .describe('The canvas version shown by the read (or draw result) where you saw the element ids (N1, T1, S1) you are using. Required when ops refer to existing elements; otherwise optional.')

// 画图没成功时（版本冲突、指令有问题）给 agent 的说明，canvas_draw 和 canvas_propose 共用
function drawFailure(res: Record<string, unknown>, baseVersion: number | undefined): { content: Content[]; isError: true } | null {
  if (res.status === 'conflict') {
    return {
      content: boardContent(
        res,
        `Nothing was drawn (conflict): ${res.error} ` +
          `You sent base_version ${baseVersion ?? '(none)'}; the canvas is now at version ${res.version}. ` +
          `Here is the current canvas. Rebuild your ops from it and call the tool again with base_version ${res.version}.`
      ),
      isError: true
    }
  }
  if (res.status === 'invalid') {
    return { content: boardContent(res, `Nothing was drawn: ${res.error}\nThe current canvas:`), isError: true }
  }
  return null
}

const newNodeIds = (res: Record<string, unknown>): string =>
  Object.entries((res.node_ids ?? {}) as Record<string, string>)
    .map(([key, id]) => `${key} = ${id}`)
    .join(', ')

type MoveSummaryItem = {
  id: string
  now_id?: string | null
  bbox?: { x: number; y: number; w: number; h: number }
  adjusted?: boolean
  overlaps?: string[]
}

const formatMoveList = (list: readonly MoveSummaryItem[], includeRename: boolean): string => {
  if (!list.length) return ''
  return list
    .map((m) => {
      const pair = includeRename && m.now_id && m.now_id !== m.id ? `${m.id} → ${m.now_id}` : m.id
      const at = m.bbox ? ` @(${Math.round(m.bbox.x)},${Math.round(m.bbox.y)} ${Math.round(m.bbox.w)}×${Math.round(m.bbox.h)})` : ''
      const notes = [
        m.adjusted ? 'adjusted around obstacles' : '',
        m.overlaps?.length ? `overlaps ${m.overlaps.join(', ')}` : ''
      ].filter(Boolean)
      return notes.length ? `${pair}${at} (${notes.join('; ')})` : `${pair}${at}`
    })
    .join(', ')
}

const formatMoved = (res: Record<string, unknown>): string =>
  formatMoveList(Array.isArray(res.moved) ? (res.moved as MoveSummaryItem[]) : [], true)

const formatProposedMoves = (res: Record<string, unknown>): string =>
  formatMoveList(Array.isArray(res.proposed_moves) ? (res.proposed_moves as MoveSummaryItem[]) : [], false)

function validateMoveOps(ops: readonly z.infer<typeof drawOpSchema>[]): string | null {
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (op.op !== 'move') continue
    const hasXY = op.x !== undefined || op.y !== undefined
    const hasDelta = op.dx !== undefined || op.dy !== undefined
    const hasNear = op.near !== undefined
    const modes = Number(hasXY) + Number(hasDelta) + Number(hasNear)
    if (modes !== 1) {
      return `ops[${i}]: move requires exactly one positioning mode: (x and y), (dx and/or dy), or (near with optional side/gap).`
    }
    if (hasXY && (op.x === undefined || op.y === undefined)) {
      return `ops[${i}]: move with top-left coordinates requires both "x" and "y".`
    }
    if (!hasNear && (op.side !== undefined || op.gap !== undefined)) {
      return `ops[${i}]: "side" and "gap" can only be used together with "near".`
    }
  }
  return null
}

server.registerTool(
  'canvas_propose',
  {
    title: 'Draw your understanding and ask the user to confirm',
    description:
      'Draw your understanding, plan, or suggested edits on the canvas as a proposal and ask the user to confirm it. ' +
      'Use this instead of canvas_draw when you are not sure you understood the user, or want confirmation before changing/moving/deleting their elements: ' +
      'new elements appear in dashed seat color, proposed edits/deletions/restyles are shown as dashed preview markers, and proposed moves also show a draggable dashed landing frame ' +
      '(the user can drag the landing frame to fine-tune the destination, or delete either the origin marker or landing frame to decline that single move). ' +
      'Takes the same ops as canvas_draw (including move and modifications to user or other-agent elements). Returns a request_id immediately; then call canvas_wait with that request_id to get the answer. ' +
      'If accepted, additions and approved changes become part of the canvas and you are told what the user changed, adjusted, or declined. If rejected, the proposal is removed. ' +
      'The request survives a restart of the canvas app, so keep using the same request_id.',
    inputSchema: {
      board: boardSchema,
      as: asSchema,
      ops: z.array(drawOpSchema).min(1).describe('What to add, move, change, restyle, or delete as the proposal, applied together as one batch.'),
      question: z.string().min(1).describe('What you want the user to confirm, in the user\'s language, e.g. "Is this the flow you meant?". Shown on the canvas.'),
      direction: directionSchema,
      base_version: baseVersionSchema
    }
  },
  ({ board, as, ops, question, direction, base_version }) => guarded(async () => {
    const invalidMove = validateMoveOps(ops)
    if (invalidMove) return { content: text(`Nothing was drawn: ${invalidMove}`).content, isError: true }
    const res = await daemon('/propose', { board, as: rememberSeat(as), ops, question, direction, base_version }, 30_000)
    const failure = drawFailure(res, base_version)
    if (failure) return failure
    if (res.status !== 'proposed') return text(JSON.stringify(res))
    const ids = newNodeIds(res)
    const proposedMoves = formatProposedMoves(res)
    const changed = (res.changed ?? {}) as { proposed?: number }
    const markerNote = changed.proposed ? ` (${changed.proposed} edit marker(s))` : ''
    return {
      content: boardContent(
        res,
        `Proposal ${res.request_id} is shown on the canvas${markerNote} and the user is being asked: "${question}". ` +
          `Now call canvas_wait with request_id "${res.request_id}" to get their answer.` +
          (ids ? ` Your proposed nodes: ${ids}.` : '') +
          (proposedMoves ? ` Planned moves: ${proposedMoves}.` : '')
      )
    }
  })
)

server.registerTool(
  'canvas_draw',
  {
    title: 'Draw on the canvas',
    description:
      'Draw, move, edit, restyle, or delete elements on the Flying draws canvas immediately. ' +
      'New nodes are laid out automatically below existing content unless x/y are given. ' +
      'You can move, modify, restyle (color, fill, shape, width, height), or delete any settled element on the canvas ' +
      '(including those drawn by the user or other agents, except unanswered proposals): ' +
      'move (by near+side, dx/dy, or top-left x+y; connected arrows follow), update_node (auto-widens from center for long text), delete_node, update_edge, delete_edge, update_text (T1), delete_text (T1), delete_strokes (S1), set_style. ' +
      'To refer to elements already on the canvas (N1, T1, S1, I1), pass the version from the read where you saw them as base_version; ' +
      'it still works if unrelated parts of the canvas changed since, unless an element you modify/move was changed by someone else. ' +
      'Note that element short ids (like N1, N2) follow reading order and may renumber after moving — check the returned moved mapping and updated summary. ' +
      'To turn a diagram image on the canvas (I1) into editable shapes, use trace_image: describe its boxes, texts and lines in the image\'s own pixel coordinates; the canvas scales them and keeps their colors. ' +
      'Returns the updated canvas description. Things you drew are tagged with your agent name in later reads.',
    inputSchema: {
      board: boardSchema,
      as: asSchema,
      ops: z.array(drawOpSchema).min(1).describe('What to add, move, change, restyle, or delete, applied together as one batch: either all of it happens or none.'),
      direction: directionSchema,
      base_version: baseVersionSchema
    }
  },
  ({ board, as, ops, base_version, direction }) => guarded(async () => {
    const invalidMove = validateMoveOps(ops)
    if (invalidMove) return { content: text(`Nothing was drawn: ${invalidMove}`).content, isError: true }
    const res = await daemon('/draw', { board, as: rememberSeat(as), ops, base_version, direction }, 30_000)
    const failure = drawFailure(res, base_version)
    if (failure) return failure
    if (res.status !== 'drawn') return text(JSON.stringify(res))
    const added = res.added as { nodes: number; edges: number; texts: number; lines?: number }
    const changed = (res.changed ?? { updated: 0, styled: 0, moved: 0, deleted: 0 }) as {
      updated: number
      styled?: number
      moved?: number
      deleted: number
    }
    const changeParts = [
      changed.updated ? `${changed.updated} text(s) updated` : '',
      changed.styled ? `${changed.styled} styled` : '',
      changed.moved ? `${changed.moved} moved` : '',
      changed.deleted ? `${changed.deleted} deleted` : ''
    ].filter(Boolean)
    const ids = newNodeIds(res)
    const movedSummary = formatMoved(res)
    const header =
      `Drawn: ${added.nodes} node(s), ${added.edges} arrow(s), ${added.texts} text(s)${added.lines ? `, ${added.lines} line(s)` : ''}.` +
      (changeParts.length ? ` Changed: ${changeParts.join(', ')}.` : '') +
      ` The canvas is now at version ${res.version}.` +
      (ids ? ` Your new nodes: ${ids}.` : '') +
      (movedSummary ? ` Moved ids: ${movedSummary}.` : '')
    return { content: boardContent(res, header) }
  })
)

// flying-draws call：给没有挂上 MCP、只有终端的 agent 用。在进程内把同一套工具接到一个客户端上，
// 调一个工具、打印结果后退出；参数校验和工具实现都和 MCP 模式是同一份。
async function runCall(args: readonly string[]): Promise<number> {
  const fail = (message: string): number => {
    process.stderr.write(`${message}\n`)
    return 1
  }
  let agentName = 'cli'
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--list') {
      process.stdout.write(`${MCP_TOOL_NAMES.join('\n')}\n`)
      return 0
    }
    if (arg === '--as' || arg === '--agent') {
      const value = args[++i]?.trim()
      if (!value) return fail(`${arg} needs a value`)
      if (arg === '--as') sessionSeat = value
      else agentName = value
      continue
    }
    positional.push(arg)
  }
  const [tool, raw, extraArg] = positional
  if (!tool) return fail('Usage: flying-draws call <tool> [json|@file|-] [--as <seat>] [--agent <name>]')
  if (extraArg !== undefined) return fail(`Unexpected argument "${extraArg}". Pass all tool arguments as one JSON object.`)
  if (!(MCP_TOOL_NAMES as readonly string[]).includes(tool)) return fail(`Unknown tool "${tool}". Available: ${MCP_TOOL_NAMES.join(', ')}`)
  let input: Record<string, unknown> = {}
  if (raw !== undefined) {
    let source: string
    try {
      source = raw === '-' ? readFileSync(0, 'utf8') : raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw
    } catch (err) {
      return fail(`Cannot read arguments: ${err instanceof Error ? err.message : String(err)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(source.replace(/^﻿/, ''))
    } catch (err) {
      return fail(`Arguments are not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('Arguments must be a JSON object')
    input = parsed as Record<string, unknown>
  }
  // 设了 FLYINGDRAWS_HOME 会连（或拉起）另一个画布实例，提前说一声，免得在空画板上白等
  if (OVERRIDE_HOME) process.stderr.write(`Note: FLYINGDRAWS_HOME is set, using the canvas at ${HOME_DIR}\n`)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: agentName, version: PKG_VERSION })
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const result = await client.callTool({ name: tool, arguments: input }, undefined, { timeout: 120_000 })
    let images = 0
    for (const item of (result.content ?? []) as Content[]) {
      if (item.type === 'text') process.stdout.write(`${item.text}\n`)
      else if (item.type === 'image') {
        const file = join(tmpdir(), `flying-draws-${Date.now()}-${++images}.png`)
        writeFileSync(file, Buffer.from(item.data, 'base64'))
        process.stdout.write(`[image saved] ${file}\n`)
      }
    }
    return result.isError ? 1 : 0
  } catch (err) {
    return fail(`Flying draws error: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await client.close().catch(() => undefined)
  }
}

async function main(): Promise<void> {
  let left = false
  const leaveOnce = () => {
    if (left) return
    left = true
    void announceSeat(true)
  }
  server.server.oninitialized = () => {
    void announceSeat()
  }
  setInterval(() => {
    if (!left) void announceSeat()
  }, 30_000).unref()
  process.stdin.once('end', leaveOnce)
  process.stdin.once('close', leaveOnce)
  const onSignal = () => {
    leaveOnce()
    setTimeout(() => process.exit(0), 150).unref()
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  await server.connect(new StdioServerTransport())
  log('ready')
}

const cliArgs = process.argv.slice(2)
if (isCliMode(cliArgs)) {
  runCli(cliArgs).catch((err) => {
    process.stderr.write(`flying-draws CLI error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
} else {
  main().catch((err) => {
    log('fatal', err)
    process.exit(1)
  })
}
