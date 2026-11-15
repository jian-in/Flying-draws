import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { buildGraph, summarize, type SceneElement } from './semantic'
import { OpsError, planOps, type DrawOp, type DrawPlan } from './ops'
import { RequestHub, type Submission, type WaitResult } from './requests'
import { startDaemon } from './daemon'

// M1：仍然只有一块画板，叫 default
// 设了 SKETCHLINK_HOME 就把画板、连接信息和 Electron 自己的数据都放到那个目录下。
// 测试用它开一个和用户画板完全隔离的实例（单实例锁也是按 userData 目录算的）。
const HOME = process.env['SKETCHLINK_HOME'] || join(homedir(), '.sketchlink')
if (process.env['SKETCHLINK_HOME']) app.setPath('userData', join(HOME, 'electron-data'))
const BOARDS_DIR = join(HOME, 'boards')
const BOARD_ID = 'default'
const boardPath = join(BOARDS_DIR, `${BOARD_ID}.excalidraw`)
const legacyM0Path = join(BOARDS_DIR, 'm0.excalidraw')
const daemonInfoPath = join(HOME, 'daemon.json')

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
hub.onChange(pushHubState)

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
      // 先拿页面上的最新状态，版本号以它为准（用户刚画的几笔可能还没落盘）
      const snap = await takeSnapshot(false)
      const ver = await acceptScene(snap.sceneJson)
      const graph = buildGraph((JSON.parse(snap.sceneJson).elements ?? []) as SceneElement[])
      const current = () => describe(snap.sceneJson, ver, { format: 'summary', image: 'never' }, null)

      let plan: DrawPlan
      try {
        plan = planOps(body.ops as DrawOp[], graph, newElementId)
      } catch (err) {
        if (err instanceof OpsError) return { status: 'invalid', error: err.message, ...current() }
        throw err
      }
      // N1 这类编号只在某一个版本里有效。引用了已有节点，就必须基于当前版本；
      // 只新增、不引用已有节点的指令在任何版本上都能执行，不算冲突。
      if (plan.existingRefs.length && Number(body.base_version) !== ver) {
        return { status: 'conflict', ...current() }
      }

      const applied = await rpc<{ sceneJson: string }>('applyPlan', plan, 12_000)
      const newVer = await acceptScene(applied.sceneJson)
      const after = buildGraph((JSON.parse(applied.sceneJson).elements ?? []) as SceneElement[])
      const nodeIds: Record<string, string> = {}
      for (const n of plan.nodes) {
        const node = after.nodes.find((x) => x.ref === n.elementId)
        if (node) nodeIds[n.key] = node.id
      }
      return {
        status: 'drawn',
        added: { nodes: plan.nodes.length, edges: plan.edges.length, texts: plan.texts.length },
        node_ids: nodeIds,
        ...describe(applied.sceneJson, newVer, { format: 'summary', image: 'never' }, null)
      }
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
ipcMain.handle('hub:submit', async (_e, payload: { requestId: string | null; note: string; sceneJson: string; pngBase64: string | null }) => {
  const ver = await acceptScene(payload.sceneJson)
  const sub: Submission = {
    requestId: payload.requestId,
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
