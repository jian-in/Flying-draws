#!/usr/bin/env node
// sketchlink-mcp：agent 通过 stdio 启动的轻量桥接进程。
// 只负责把 MCP 工具调用转发给桌面应用的本地服务；应用没开时自动拉起来。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// SKETCHLINK_HOME 和桌面应用用的是同一个变量；桥接拉起应用时环境变量会传下去
const DAEMON_INFO = join(process.env.SKETCHLINK_HOME || join(homedir(), '.sketchlink'), 'daemon.json')
const APP_ROOT = resolve(__dirname, '..', '..')
const LAUNCH_TIMEOUT_MS = 30_000

interface DaemonInfo {
  port: number
  token: string
}

const log = (...args: unknown[]) => console.error('[sketchlink-mcp]', ...args) // stdout 留给 MCP 协议

function readInfo(): DaemonInfo | null {
  try {
    return JSON.parse(readFileSync(DAEMON_INFO, 'utf8')) as DaemonInfo
  } catch {
    return null
  }
}

// 用 node:http 而不是 fetch：fetch 在某些环境会读代理变量，本机请求不该走代理
function call(info: DaemonInfo, path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const isGet = path === '/health'
    const data = Buffer.from(JSON.stringify(body ?? {}))
    // GET 不能带 content-length：连接复用时服务端会把下一个请求的开头当成这次的请求体
    const headers: http.OutgoingHttpHeaders = { 'x-sketchlink-token': info.token }
    if (!isGet) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = data.length
    }
    const req = http.request(
      { host: '127.0.0.1', port: info.port, path, method: isGet ? 'GET' : 'POST', headers, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let parsed: Record<string, unknown> = {}
          try {
            parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
          } catch {
            return reject(new Error(`bad response from canvas app (HTTP ${res.statusCode}): ${raw.slice(0, 200)}`))
          }
          if ((res.statusCode ?? 500) >= 400) reject(new Error(String(parsed.error ?? `HTTP ${res.statusCode}`)))
          else resolvePromise(parsed)
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error(`request to ${path} timed out`)))
    req.on('error', reject)
    if (!isGet) req.write(data)
    req.end()
  })
}

async function healthy(info: DaemonInfo | null): Promise<boolean> {
  if (!info) return false
  try {
    await call(info, '/health', null, 1500)
    return true
  } catch {
    return false
  }
}

function launchApp(): void {
  if (!existsSync(join(APP_ROOT, 'out', 'main', 'index.js'))) {
    throw new Error(`Sketchlink is not built yet. Run "npm run build" in ${APP_ROOT} first.`)
  }
  // 在 Node 里 require('electron') 拿到的是 Electron 可执行文件的路径
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronPath = require('electron') as string
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [APP_ROOT], { detached: true, stdio: 'ignore', env, windowsHide: false })
  child.unref()
  log('launched canvas app, pid', child.pid)
}

let launching: Promise<DaemonInfo> | null = null

async function ensureDaemon(): Promise<DaemonInfo> {
  const info = readInfo()
  if (await healthy(info)) return info!
  if (!launching) {
    launching = (async () => {
      launchApp()
      const deadline = Date.now() + LAUNCH_TIMEOUT_MS
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400))
        const fresh = readInfo()
        if (await healthy(fresh)) return fresh!
      }
      throw new Error('Sketchlink canvas app did not start within 30s')
    })().finally(() => {
      launching = null
    })
  }
  return launching
}

async function daemon(path: string, body: unknown, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const info = await ensureDaemon()
  return call(info, path, body, timeoutMs)
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
    return { content: [{ type: 'text', text: `Sketchlink error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
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

const server = new McpServer({ name: 'sketchlink', version: '0.1.0' })

server.registerTool(
  'canvas_open',
  {
    title: 'Open the Sketchlink canvas',
    description:
      'Open the local Sketchlink drawing canvas window (starting the app if needed) and bring it to the front. ' +
      'Use it when the user wants to sketch something, or before asking them to draw.',
    inputSchema: {}
  },
  () => guarded(async () => {
    const res = await daemon('/open', {})
    return text(`Canvas "${res.board}" is open (version ${res.version}). The user can draw on it now.`)
  })
)

server.registerTool(
  'canvas_read',
  {
    title: 'Read the canvas',
    description:
      'Read what is currently drawn on the Sketchlink canvas. Returns a description of nodes (boxes with their text), ' +
      'arrows between them, free text notes and where they sit, and hand-drawn strokes. ' +
      'The first line shows the canvas version (e.g. v12). Node ids like N1 are valid only for that version. Use this when the user says they drew something or refers to "the canvas" / "my sketch".',
    inputSchema: { format: formatSchema, image: imageSchema }
  },
  ({ format, image }) => guarded(async () => {
    const res = await daemon('/read', { format: format ?? 'summary', image: image ?? 'auto' }, 20_000)
    return { content: boardContent(res) }
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
      prompt: z.string().min(1).describe('What you want the user to draw, in the user\'s language. Shown on the canvas.')
    }
  },
  ({ prompt }) => guarded(async () => {
    const res = await daemon('/request', { prompt })
    return text(
      `Request ${res.request_id} is shown on the canvas. Now call canvas_wait with request_id "${res.request_id}" to receive the drawing.`
    )
  })
)

server.registerTool(
  'canvas_wait',
  {
    title: 'Wait for the user\'s drawing',
    description:
      'Wait until the user presses "Send" on the canvas, for at most timeout_s seconds (max 45). ' +
      'With request_id: waits for the answer to that canvas_request. Without it: waits for the user to send the canvas on their own. ' +
      'If the result says the user is still drawing, call canvas_wait again. After about 3 empty waits, stop and tell the user in the chat that you are waiting for their drawing instead of retrying silently.',
    inputSchema: {
      request_id: z.string().optional().describe('The id returned by canvas_request.'),
      timeout_s: z.number().int().min(1).max(45).optional().describe('How long to wait, in seconds. Default 40.'),
      format: formatSchema,
      image: imageSchema
    }
  },
  ({ request_id, timeout_s, format, image }) => guarded(async () => {
    const wait = timeout_s ?? 40
    const res = await daemon('/wait', { request_id, timeout_s: wait, format: format ?? 'summary', image: image ?? 'auto' }, (wait + 10) * 1000)
    switch (res.status) {
      case 'submitted': {
        const note = res.note ? `The user's note: "${res.note}"` : 'The user added no note.'
        return { content: boardContent(res, `The user sent the canvas. ${note}`) }
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

const opSchema = z.discriminatedUnion('op', [
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
])

server.registerTool(
  'canvas_draw',
  {
    title: 'Draw on the canvas',
    description:
      'Draw nodes, arrows and text on the Sketchlink canvas so the user can see your understanding or plan as a diagram. ' +
      'You only say what to add; the canvas picks positions. This tool only adds things: it cannot move, change or delete what is already there. ' +
      'To connect to nodes that are already on the canvas, call canvas_read first and pass the version it showed as base_version. ' +
      'Returns the updated canvas description. Things you drew are marked as drawn by the agent in later reads.',
    inputSchema: {
      ops: z.array(opSchema).min(1).describe('What to add, applied together as one batch: either all of it is drawn or none.'),
      base_version: z
        .number()
        .int()
        .optional()
        .describe('The canvas version from your latest canvas_read. Required when ops refer to existing nodes (N1, N2, ...); otherwise optional.')
    }
  },
  ({ ops, base_version }) => guarded(async () => {
    const res = await daemon('/draw', { ops, base_version }, 30_000)
    switch (res.status) {
      case 'drawn': {
        const added = res.added as { nodes: number; edges: number; texts: number }
        const ids = Object.entries((res.node_ids ?? {}) as Record<string, string>)
          .map(([key, id]) => `${key} = ${id}`)
          .join(', ')
        const header =
          `Drawn: ${added.nodes} node(s), ${added.edges} arrow(s), ${added.texts} text(s). The canvas is now at version ${res.version}.` +
          (ids ? ` Your new nodes: ${ids}.` : '')
        return { content: boardContent(res, header) }
      }
      case 'conflict':
        return {
          content: boardContent(
            res,
            `Nothing was drawn: the canvas changed since version ${base_version ?? '(none given)'} and is now at version ${res.version}, so node ids like N1 may point to different nodes. ` +
              `Here is the current canvas. Rebuild your ops from it and call canvas_draw again with base_version ${res.version}.`
          ),
          isError: true
        }
      case 'invalid':
        return { content: boardContent(res, `Nothing was drawn: ${res.error}\nThe current canvas:`), isError: true }
      default:
        return text(JSON.stringify(res))
    }
  })
)

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport())
  log('ready')
}

main().catch((err) => {
  log('fatal', err)
  process.exit(1)
})
