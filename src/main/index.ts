import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { buildGraph, summarize, type SceneElement } from './semantic'
import { OpsError, planOps, type DrawOp, type DrawPlan } from './ops'
import { RequestHub, type DrawRequest, type Submission, type WaitResult } from './requests'
import { captureBaseline, diffProposal, type DiffElement, type ProposalBaseline } from './diff'
import { startDaemon } from './daemon'

// M1：仍然只有一块画板，叫 default
// 设了 SKETCHLINK_HOME 就把画板、连接信息和 Electron 自己的数据都放到那个目录下。
// 测试用它开一个和用户画板完全隔离的实例（单实例锁也是按 userData 目录算的）。
const HOME = process.env['SKETCHLINK_HOME'] || join(homedir(), '.sketchlink')
if (process.env['SKETCHLINK_HOME']) app.setPath('userData', join(HOME, 'electron-data'))
// 端到端测试要在页面里点按钮，用这个变量打开 Chrome DevTools 端口。只在隔离实例上认。
if (process.env['SKETCHLINK_HOME'] && process.env['SKETCHLINK_DEBUG_PORT']) {
  app.commandLine.appendSwitch('remote-debugging-port', String(Number(process.env['SKETCHLINK_DEBUG_PORT'])))
}
const BOARDS_DIR = join(HOME, 'boards')
const BOARD_ID = 'default'
const boardPath = join(BOARDS_DIR, `${BOARD_ID}.excalidraw`)
const legacyM0Path = join(BOARDS_DIR, 'm0.excalidraw')
const daemonInfoPath = join(HOME, 'daemon.json')
const pendingPath = join(HOME, 'pending.json')

const WAIT_MAX_S = 45
const WAIT_DEFAULT_S = 40

let win: BrowserWindow | null = null
const hub = new RequestHub()

// ---------- 画板状态和版本号 ----------

let version = 0
let lastElementsKey: number | null = null
let saveCount = 0

// 和渲染进程用同一个算法：元素的 version 之和加元素个数，变了就说明画面内容变了
function elementsKey(elements: { version?: number }[]): number {
  let sum = 0
  for (const el of elements) sum += el.version ?? 0
  return sum + elements.length
}

async function loadBoard(): Promise<{ json: string | null; path: string }> {
  // M0 时画板叫 m0，第一次运行 M1 时改名成 default
  if (!existsSync(boardPath) && existsSync(legacyM0Path)) await rename(legacyM0Path, boardPath)
  try {
    const json = await readFile(boardPath, 'utf8')
    const scene = JSON.parse(json)
    version = Number(scene?.sketchlink?.version) || 1
    lastElementsKey = elementsKey(scene.elements ?? [])
    return { json, path: boardPath }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { json: null, path: boardPath }
    throw err
  }
}

// 接收一份最新的场景：内容变了就升版本号并落盘，返回当前版本号
async function acceptScene(json: string): Promise<number> {
  const scene = JSON.parse(json)
  const key = elementsKey(scene.elements ?? [])
  if (key === lastElementsKey) return version
  lastElementsKey = key
  version += 1
  scene.sketchlink = { version }
  await mkdir(BOARDS_DIR, { recursive: true })
  // 先写临时文件再改名，写到一半崩溃也不会留下半个文件
  const tmp = `${boardPath}.tmp`
  await writeFile(tmp, JSON.stringify(scene), 'utf8')
  await rename(tmp, boardPath)
  saveCount += 1
  return version
}

// ---------- 主进程向页面发起调用（RPC） ----------

let rpcSeq = 0
const rpcPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

function rpc<T>(method: string, params: unknown = {}, timeoutMs = 8000): Promise<T> {
  if (!win || win.isDestroyed()) return Promise.reject(new Error('canvas window is not open'))
  const id = ++rpcSeq
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      rpcPending.delete(id)
      reject(new Error(`renderer did not answer ${method} in ${timeoutMs}ms`))
    }, timeoutMs)
    rpcPending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    win!.webContents.send('rpc', { id, method, params })
  })
}

ipcMain.on('rpc:reply', (_e, msg: { id: number; result?: unknown; error?: string }) => {
  const p = rpcPending.get(msg.id)
  if (!p) return
  clearTimeout(p.timer)
  rpcPending.delete(msg.id)
  if (msg.error) p.reject(new Error(msg.error))
  else p.resolve(msg.result)
})

interface Snapshot {
  sceneJson: string
  pngBase64: string | null
}

// ---------- 窗口 ----------

function bringToFront(): void {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  // Windows 会拦截后台程序抢焦点，短暂置顶再取消，保证窗口能跳到前面
  win.setAlwaysOnTop(true)
  win.focus()
  setTimeout(() => win?.setAlwaysOnTop(false), 300)
}

let windowReady: Promise<void> = Promise.resolve()

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Sketchlink',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })
  windowReady = new Promise((resolve) => ipcMain.once('renderer:ready', () => resolve()))

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('closed', () => {
    win = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function pushHubState(): void {
  if (win && !win.isDestroyed()) win.webContents.send('hub:state', hub.state())
}

// ---------- 还在等用户回应的请求：存盘，重启后恢复 ----------
// 不存的话，应用重启后横幅没了，提议层上的元素却还留在画布上，没有按钮可以确认。

let lastPendingKey = ''

function persistPending(): void {
  const waiting = hub.waiting()
  const key = waiting.map((r) => r.id).join(',')
  if (key === lastPendingKey) return // 只是有 agent 开始或结束等待，请求本身没变
  lastPendingKey = key
  try {
    mkdirSync(HOME, { recursive: true })
    // 请求不多、文件很小，同步写，保证应用被强杀前已经落盘
    writeFileSync(pendingPath, JSON.stringify({ board: BOARD_ID, requests: waiting }), 'utf8')
  } catch (err) {
    console.error('[sketchlink] could not save pending requests:', err)
  }
}

function restorePending(): void {
  let saved: DrawRequest[] = []
  try {
    saved = JSON.parse(readFileSync(pendingPath, 'utf8')).requests ?? []
  } catch {
    return // 没有存过，或者文件坏了：当作没有待处理的请求
  }
  // 提议对应的元素要是已经不在画板上了（比如用户手动删光了），这个提议就不用再问
  let proposalsOnBoard = new Set<string>()
  try {
    const elements = (JSON.parse(readFileSync(boardPath, 'utf8')).elements ?? []) as DiffElement[]
    proposalsOnBoard = new Set(
      elements.filter((el) => !el.isDeleted && el.customData?.sketchlink?.layer === 'proposal').map((el) => String(el.customData?.sketchlink?.proposal))
    )
  } catch {}
  const usable = saved.filter((r) => r && typeof r.id === 'string' && (r.kind !== 'proposal' || (r.proposalId && proposalsOnBoard.has(r.proposalId))))
  lastPendingKey = usable.map((r) => r.id).join(',')
  hub.restore(usable)
}

hub.onChange(() => {
  pushHubState()
  persistPending()
})

// ---------- 给 agent 的响应 ----------

type ImageMode = 'auto' | 'always' | 'never'

function describe(sceneJson: string, ver: number, opts: { format: string; image: ImageMode }, png: string | null) {
  const scene = JSON.parse(sceneJson)
  const graph = buildGraph((scene.elements ?? []) as SceneElement[])
  let summary = summarize(graph, { board: BOARD_ID, version: ver })
  const wantImage = opts.image === 'always' || (opts.image === 'auto' && graph.needsImage)
  const attached = wantImage && Boolean(png)
  if (graph.needsImage) {
    summary += attached
      ? '\n提示：有文字描述不了的内容（手写、涂鸦、图片或线条），已附画布截图。'
      : '\n提示：有文字描述不了的内容（手写、涂鸦、图片或线条），需要的话用 image: "always" 再读一次拿截图。'
  }
  return {
    board: BOARD_ID,
    version: ver,
    summary,
    graph: opts.format === 'graph' ? graph : undefined,
    needs_image: graph.needsImage,
    image_png_base64: attached ? png : null
  }
}

function imageMode(v: unknown): ImageMode {
  return v === 'always' || v === 'never' ? v : 'auto'
}

async function takeSnapshot(withImage: boolean): Promise<Snapshot> {
  await windowReady
  return rpc<Snapshot>('snapshot', { image: withImage })
}

// 所有写入排成一队，一次只执行一批（design.md 12.2）
let writeChain: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn)
  writeChain = run.catch(() => undefined)
  return run
}

const newElementId = (): string => `sl_${randomBytes(8).toString('hex')}`

// /draw 和 /propose 共用：把一批指令画到画布上。proposalId 不为空时画在提议层上。
// 要在 serialized() 里面调用。
async function drawOps(
  body: Record<string, unknown>,
  proposalId: string | null
): Promise<{ ok: boolean; result: Record<string, unknown>; sceneJson?: string }> {
  // 先拿页面上的最新状态，版本号以它为准（用户刚画的几笔可能还没落盘）
  const snap = await takeSnapshot(false)
  const ver = await acceptScene(snap.sceneJson)
  const graph = buildGraph((JSON.parse(snap.sceneJson).elements ?? []) as SceneElement[])
  const current = () => describe(snap.sceneJson, ver, { format: 'summary', image: 'never' }, null)

  let plan: DrawPlan
  try {
    plan = planOps(body.ops as DrawOp[], graph, newElementId, { direction: body.direction === 'down' ? 'down' : 'right' })
  } catch (err) {
    if (err instanceof OpsError) return { ok: false, result: { status: 'invalid', error: err.message, ...current() } }
    throw err
  }
  // N1 这类编号只在某一个版本里有效。引用了已有节点，就必须基于当前版本；
  // 只新增、不引用已有节点的指令在任何版本上都能执行，不算冲突。
  if (plan.existingRefs.length && Number(body.base_version) !== ver) {
    return { ok: false, result: { status: 'conflict', ...current() } }
  }

  const applied = await rpc<{ sceneJson: string }>('applyPlan', { plan, proposalId }, 12_000)
  const newVer = await acceptScene(applied.sceneJson)
  const after = buildGraph((JSON.parse(applied.sceneJson).elements ?? []) as SceneElement[])
  const nodeIds: Record<string, string> = {}
  for (const n of plan.nodes) {
    const node = after.nodes.find((x) => x.ref === n.elementId)
    if (node) nodeIds[n.key] = node.id
  }
  return {
    ok: true,
    sceneJson: applied.sceneJson,
    result: {
      added: { nodes: plan.nodes.length, edges: plan.edges.length, texts: plan.texts.length },
      node_ids: nodeIds,
      ...describe(applied.sceneJson, newVer, { format: 'summary', image: 'never' }, null)
    }
  }
}

const routes = {
  '/open': async () => {
    bringToFront()
    await windowReady
    return { board: BOARD_ID, version, window: 'shown' }
  },

  '/read': async (body: Record<string, unknown>) => {
    const image = imageMode(body.image)
    if (!win) {
      bringToFront()
    }
    // 先不要图，算完语义发现需要时再要，省一次导出
    let snap = await takeSnapshot(image === 'always')
    const ver = await acceptScene(snap.sceneJson)
    let res = describe(snap.sceneJson, ver, { format: String(body.format ?? 'summary'), image }, snap.pngBase64)
    if (image === 'auto' && res.needs_image && !snap.pngBase64) {
      snap = await takeSnapshot(true)
      res = describe(snap.sceneJson, ver, { format: String(body.format ?? 'summary'), image }, snap.pngBase64)
    }
    return res
  },

  '/draw': (body: Record<string, unknown>) =>
    serialized(async () => {
      if (!win || win.isMinimized()) bringToFront()
      const res = await drawOps(body, null)
      return res.ok ? { status: 'drawn', ...res.result } : res.result
    }),

  // 画在提议层上，并弹出横幅请用户确认。结果用 /wait 等。
  '/propose': (body: Record<string, unknown>) =>
    serialized(async () => {
      const question = String(body.question ?? '').trim()
      if (!question) throw new Error('question is required')
      const proposalId = `prop_${randomBytes(6).toString('hex')}`
      const res = await drawOps(body, proposalId)
      if (!res.ok) return res.result
      // 画成功了才弹横幅，不然用户会看到一个没有内容的确认请求
      // 记下提议刚画上去的样子，用户表态时拿来比出改了哪里
      const baseline = captureBaseline((JSON.parse(res.sceneJson ?? '{}').elements ?? []) as DiffElement[], proposalId)
      const req = hub.create(question, proposalId, baseline)
      bringToFront()
      return { status: 'proposed', request_id: req.id, ...res.result }
    }),

  '/request': async (body: Record<string, unknown>) => {
    const prompt = String(body.prompt ?? '').trim()
    if (!prompt) throw new Error('prompt is required')
    const req = hub.create(prompt)
    bringToFront()
    return { request_id: req.id, board: BOARD_ID, status: 'waiting' }
  },

  '/wait': async (body: Record<string, unknown>) => {
    const seconds = Math.min(Math.max(Number(body.timeout_s) || WAIT_DEFAULT_S, 1), WAIT_MAX_S)
    const requestId = typeof body.request_id === 'string' && body.request_id ? body.request_id : null
    const result: WaitResult = await hub.wait(requestId ? { requestId } : { inbox: true }, seconds * 1000)
    if (result.status !== 'submitted') return { ...result, request_id: requestId }
    const sub = result.submission
    return {
      status: 'submitted',
      request_id: sub.requestId,
      decision: sub.decision ?? null,
      changes: sub.changes ?? null,
      note: sub.note,
      submitted_at: sub.at,
      ...describe(sub.sceneJson, sub.version, { format: String(body.format ?? 'summary'), image: imageMode(body.image) }, sub.pngBase64)
    }
  }
}

// ---------- 页面发来的调用 ----------

ipcMain.handle('board:load', () => loadBoard())
ipcMain.handle('board:save', async (_e, json: unknown) => {
  if (typeof json !== 'string') throw new Error('board:save expects a JSON string')
  const ver = await acceptScene(json)
  return { path: boardPath, saveCount, version: ver, savedAt: new Date().toISOString() }
})
ipcMain.handle('board:reveal', () => shell.showItemInFolder(boardPath))
ipcMain.handle('hub:state', () => hub.state())
type SubmitPayload = { requestId: string | null; note: string; sceneJson: string; pngBase64: string | null; decision?: 'accepted' | 'rejected' | null }
ipcMain.handle('hub:submit', async (_e, payload: SubmitPayload) => {
  const ver = await acceptScene(payload.sceneJson)
  const decision = payload.decision === 'accepted' || payload.decision === 'rejected' ? payload.decision : null
  // 回应提议时，比出用户在提议上改了什么。拒绝时提议已经被删掉，只看用户自己加了什么没有意义，不比。
  const req = payload.requestId ? hub.get(payload.requestId) : undefined
  let changes: string[] | null = null
  if (decision === 'accepted' && req?.kind === 'proposal' && req.baseline) {
    changes = diffProposal(req.baseline as ProposalBaseline, (JSON.parse(payload.sceneJson).elements ?? []) as DiffElement[])
  }
  const sub: Submission = {
    requestId: payload.requestId,
    decision,
    changes,
    note: String(payload.note ?? '').trim(),
    sceneJson: payload.sceneJson,
    pngBase64: payload.pngBase64,
    version: ver,
    at: new Date().toISOString()
  }
  hub.submit(sub)
  return { version: ver }
})
ipcMain.handle('hub:cancel', (_e, requestId: string) => hub.cancel(requestId))

// ---------- 启动 ----------

// 同一时间只允许一个实例，第二次启动时把已有窗口带到前面
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => bringToFront())

  let closeDaemon: (() => Promise<void>) | null = null

  app.whenReady().then(async () => {
    restorePending()
    createWindow()
    const { close } = await startDaemon(daemonInfoPath, routes)
    closeDaemon = close
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', (event) => {
    if (!closeDaemon) return
    event.preventDefault()
    const close = closeDaemon
    closeDaemon = null
    void close().finally(() => app.quit())
  })
}
