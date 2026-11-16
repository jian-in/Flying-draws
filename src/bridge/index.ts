#!/usr/bin/env node
// flying-draws-mcp：agent 通过 stdio 启动的轻量桥接进程。
// 只负责把 MCP 工具调用转发给桌面应用的本地服务；应用没开时自动拉起来。
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// FLYINGDRAWS_HOME 和桌面应用用的是同一个变量；桥接拉起应用时环境变量会传下去
const DAEMON_INFO = join(process.env.FLYINGDRAWS_HOME || join(homedir(), '.flyingdraws'), 'daemon.json')
const APP_ROOT = resolve(__dirname, '..', '..')
const LAUNCH_TIMEOUT_MS = 30_000

interface DaemonInfo {
  port: number
  token: string
}

const log = (...args: unknown[]) => console.error('[flying-draws-mcp]', ...args) // stdout 留给 MCP 协议

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
    const headers: http.OutgoingHttpHeaders = { 'x-flyingdraws-token': info.token }
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
    throw new Error(`Flying draws is not built yet. Run "npm run build" in ${APP_ROOT} first.`)
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
      throw new Error('Flying draws canvas app did not start within 30s')
    })().finally(() => {
      launching = null
    })
  }
  return launching
}

const BRIDGE_ID = randomUUID()

async function daemon(path: string, body: unknown, timeoutMs = 15_000): Promise<Record<string, unknown>> {
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
  return call(info, path, payload, timeoutMs)
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

const server = new McpServer({ name: 'flying-draws', version: '0.1.0' })
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
    inputSchema: { as: asSchema }
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
    inputSchema: { board: boardSchema, format: formatSchema, image: imageSchema, as: asSchema }
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
  ({ request_id, board, as, timeout_s, format, image }) => guarded(async () => {
    const wait = timeout_s ?? 40
    const res = await daemon('/wait', { request_id, board, as: rememberSeat(as), timeout_s: wait, format: format ?? 'summary', image: image ?? 'auto' }, (wait + 10) * 1000)
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
const modifyOps = [
  z.object({ op: z.literal('update_node'), id: z.string().min(1).describe(existingNode), label: z.string().describe('The new text inside the node.') }),
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

const drawOpSchema = z.discriminatedUnion('op', [...addOps, ...modifyOps])

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

server.registerTool(
  'canvas_propose',
  {
    title: 'Draw your understanding and ask the user to confirm',
    description:
      'Draw your understanding, plan, or suggested edits on the canvas as a proposal and ask the user to confirm it. ' +
      'Use this instead of canvas_draw when you are not sure you understood the user, or want confirmation before changing/deleting their elements: ' +
      'new elements appear in dashed blue, and proposed edits/deletions/restyles are shown as dashed preview markers (the user can delete any marker frame to decline that single change). ' +
      'Takes the same ops as canvas_draw (including modifications to user or other-agent elements). Returns a request_id immediately; then call canvas_wait with that request_id to get the answer. ' +
      'If accepted, additions and approved changes become part of the canvas and you are told what the user changed or declined. If rejected, the proposal is removed. ' +
      'The request survives a restart of the canvas app, so keep using the same request_id.',
    inputSchema: {
      board: boardSchema,
      as: asSchema,
      ops: z.array(drawOpSchema).min(1).describe('What to add, change, restyle, or delete as the proposal, applied together as one batch.'),
      question: z.string().min(1).describe('What you want the user to confirm, in the user\'s language, e.g. "Is this the flow you meant?". Shown on the canvas.'),
      direction: directionSchema,
      base_version: baseVersionSchema
    }
  },
  ({ board, as, ops, question, direction, base_version }) => guarded(async () => {
    const res = await daemon('/propose', { board, as: rememberSeat(as), ops, question, direction, base_version }, 30_000)
    const failure = drawFailure(res, base_version)
    if (failure) return failure
    if (res.status !== 'proposed') return text(JSON.stringify(res))
    const ids = newNodeIds(res)
    const changed = (res.changed ?? {}) as { proposed?: number }
    const markerNote = changed.proposed ? ` (${changed.proposed} edit marker(s))` : ''
    return {
      content: boardContent(
        res,
        `Proposal ${res.request_id} is shown on the canvas${markerNote} and the user is being asked: "${question}". ` +
          `Now call canvas_wait with request_id "${res.request_id}" to get their answer.` +
          (ids ? ` Your proposed nodes: ${ids}.` : '')
      )
    }
  })
)

server.registerTool(
  'canvas_draw',
  {
    title: 'Draw on the canvas',
    description:
      'Draw, edit, restyle, or delete elements on the Flying draws canvas immediately. ' +
      'New nodes are laid out automatically below existing content unless x/y are given. ' +
      'You can modify, restyle (color, fill, shape, width, height), or delete any settled element on the canvas ' +
      '(including those drawn by the user or other agents, except unanswered proposals): ' +
      'update_node, delete_node, update_edge, delete_edge, update_text (T1), delete_text (T1), delete_strokes (S1), set_style. ' +
      'To refer to elements already on the canvas (N1, T1, S1), pass the version from the read where you saw them as base_version; ' +
      'it still works if unrelated parts of the canvas changed since, unless an element you modify was changed by someone else. ' +
      'Returns the updated canvas description. Things you drew are tagged with your agent name in later reads.',
    inputSchema: {
      board: boardSchema,
      as: asSchema,
      ops: z.array(drawOpSchema).min(1).describe('What to add, change, restyle, or delete, applied together as one batch: either all of it happens or none.'),
      direction: directionSchema,
      base_version: baseVersionSchema
    }
  },
  ({ board, as, ops, base_version, direction }) => guarded(async () => {
    const res = await daemon('/draw', { board, as: rememberSeat(as), ops, base_version, direction }, 30_000)
    const failure = drawFailure(res, base_version)
    if (failure) return failure
    if (res.status !== 'drawn') return text(JSON.stringify(res))
    const added = res.added as { nodes: number; edges: number; texts: number }
    const changed = (res.changed ?? { updated: 0, styled: 0, deleted: 0 }) as {
      updated: number
      styled?: number
      deleted: number
    }
    const changeParts = [
      changed.updated ? `${changed.updated} text(s) updated` : '',
      changed.styled ? `${changed.styled} styled` : '',
      changed.deleted ? `${changed.deleted} deleted` : ''
    ].filter(Boolean)
    const ids = newNodeIds(res)
    const header =
      `Drawn: ${added.nodes} node(s), ${added.edges} arrow(s), ${added.texts} text(s).` +
      (changeParts.length ? ` Changed: ${changeParts.join(', ')}.` : '') +
      ` The canvas is now at version ${res.version}.` +
      (ids ? ` Your new nodes: ${ids}.` : '')
    return { content: boardContent(res, header) }
  })
)

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

main().catch((err) => {
  log('fatal', err)
  process.exit(1)
})
