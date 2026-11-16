import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { buildGraph, summarize, type SceneElement } from './semantic'
import { MODIFY_OPS, OpsError, planOps, rebaseOps, type DrawOp, type DrawPlan } from './ops'
import { RequestHub, type DrawRequest, type HubState, type Submission, type WaitResult } from './requests'
import { captureBaseline, diffProposal, type DiffElement, type ProposalBaseline } from './diff'
import { startDaemon } from './daemon'
import {
  BOARD_EXT,
  DEFAULT_BOARD_ID,
  boardFilePath,
  emptyBoardScene,
  isValidBoardId,
  normalizeBoardId,
  normalizeBoardTitle,
  parseBoardMeta,
  pickFallbackBoard,
  updateBoardSceneTitle,
  validateBoardId,
  type BoardMeta
} from './boards'

// 设了 FLYINGDRAWS_HOME 就把画板、连接信息和 Electron 自己的数据都放到那个目录下。
// 测试用它开一个和用户画板完全隔离的实例（单实例锁也是按 userData 目录算的）。
const HOME = process.env['FLYINGDRAWS_HOME'] || join(homedir(), '.flyingdraws')
if (process.env['FLYINGDRAWS_HOME']) app.setPath('userData', join(HOME, 'electron-data'))
// 端到端测试要在页面里点按钮，用这个变量打开 Chrome DevTools 端口。只在隔离实例上认。
if (process.env['FLYINGDRAWS_HOME'] && process.env['FLYINGDRAWS_DEBUG_PORT']) {
  app.commandLine.appendSwitch('remote-debugging-port', String(Number(process.env['FLYINGDRAWS_DEBUG_PORT'])))
}
const BOARDS_DIR = join(HOME, 'boards')
const legacyM0Path = join(BOARDS_DIR, 'm0.excalidraw')
const daemonInfoPath = join(HOME, 'daemon.json')
const pendingPath = join(HOME, 'pending.json')
const statePath = join(HOME, 'state.json')

const WAIT_MAX_S = 45
const WAIT_DEFAULT_S = 40

let win: BrowserWindow | null = null

// ---------- 多画板会话状态 ----------

interface VersionRecord {
  nodes: { id: string; ref: string; label: string | null }[]
  fingerprints: Map<string, string> // 元素 id → 指纹
}
const HISTORY_LIMIT = 60

interface BoardSession {
  id: string
  title: string | null
  version: number
  lastElementsKey: number | null
  hub: RequestHub
  history: Map<number, VersionRecord>
}

interface BoardInfo extends BoardMeta {
  active: boolean
}

const sessions = new Map<string, BoardSession>()
const requestBoard = new Map<string, string>() // request_id → boardId
let saveCount = 0

function readSavedBoardId(): string {
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as { currentBoard?: unknown }
    if (typeof raw.currentBoard === 'string' && isValidBoardId(raw.currentBoard)) return raw.currentBoard
  } catch {}
  return DEFAULT_BOARD_ID
}

let currentBoardId = readSavedBoardId()

function persistCurrentBoard(): void {
  try {
    mkdirSync(HOME, { recursive: true })
    writeFileSync(statePath, JSON.stringify({ currentBoard: currentBoardId }), 'utf8')
  } catch (err) {
    console.error('[flyingdraws] could not save active board:', err)
  }
}

function getSession(id: string): BoardSession {
  let s = sessions.get(id)
  if (!s) {
    const hub = new RequestHub()
    const session: BoardSession = { id, title: null, version: 0, lastElementsKey: null, hub, history: new Map() }
    hub.onChange(() => {
      if (session.id === currentBoardId) pushHubState()
      persistPending()
    })
    sessions.set(id, session)
    s = session
  }
  return s
}

function updateWindowTitle(): void {
  if (!win || win.isDestroyed()) return
  const s = getSession(currentBoardId)
  win.setTitle(s.title ? `Flying draws — ${s.title} (${s.id})` : `Flying draws — ${s.id}`)
}

// 顶上那一条的高度和颜色，要和 styles.css 里的 --fd-titlebar-h、--fd-paper 保持一致
const TITLEBAR_HEIGHT = 36
const TITLEBAR_COLORS = {
  light: { color: '#fffbe6', symbolColor: '#2b2a26' },
  dark: { color: '#181508', symbolColor: '#e9e2c8' }
}

// ---------- 画板读写与版本号 ----------

// 和渲染进程用同一个算法：元素的 version 之和加元素个数，变了就说明画面内容变了
function elementsKey(elements: { version?: number }[]): number {
  let sum = 0
  for (const el of elements) sum += el.version ?? 0
  return sum + elements.length
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(BOARDS_DIR, { recursive: true })
  const tmp = `${filePath}.tmp`
  await writeFile(tmp, JSON.stringify(data), 'utf8')
  await rename(tmp, filePath)
}

async function loadBoard(id = currentBoardId): Promise<{ board: string; title: string | null; version: number; json: string | null; path: string }> {
  const path = boardFilePath(BOARDS_DIR, id)
  const session = getSession(id)
  // M0 时画板叫 m0，第一次运行 M1 时改名成 default
  if (id === DEFAULT_BOARD_ID && !existsSync(path) && existsSync(legacyM0Path)) {
    await rename(legacyM0Path, path)
  }
  try {
    const json = await readFile(path, 'utf8')
    const scene = JSON.parse(json)
    session.version = Number(scene?.flyingdraws?.version) || 1
    session.title = typeof scene?.flyingdraws?.title === 'string' && scene.flyingdraws.title.trim() ? scene.flyingdraws.title.trim() : null
    session.lastElementsKey = elementsKey(scene.elements ?? [])
    return { board: id, title: session.title, version: session.version, json, path }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      session.version = 0
      session.lastElementsKey = null
      return { board: id, title: session.title, version: session.version, json: null, path }
    }
    throw err
  }
}

// 接收一份最新的场景：内容变了就升版本号并落盘，返回当前版本号
async function acceptScene(json: string, id = currentBoardId): Promise<number> {
  const session = getSession(id)
  const path = boardFilePath(BOARDS_DIR, id)
  const scene = JSON.parse(json)
  const key = elementsKey(scene.elements ?? [])
  if (key === session.lastElementsKey) return session.version
  session.lastElementsKey = key
  session.version += 1
  scene.flyingdraws = { version: session.version, ...(session.title ? { title: session.title } : {}) }
  await atomicWriteJson(path, scene)
  saveCount += 1
  return session.version
}

async function listBoards(): Promise<BoardInfo[]> {
  const items: BoardInfo[] = []
  let entries: string[] = []
  try {
    entries = await readdir(BOARDS_DIR)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const seen = new Set<string>()
  for (const name of entries) {
    if (!name.endsWith(BOARD_EXT)) continue
    const id = name.slice(0, -BOARD_EXT.length)
    if (!isValidBoardId(id)) continue
    seen.add(id)
    const file = boardFilePath(BOARDS_DIR, id)
    try {
      const [json, st] = await Promise.all([readFile(file, 'utf8'), stat(file)])
      items.push({ ...parseBoardMeta(id, json, st.mtime.toISOString()), active: id === currentBoardId })
    } catch {}
  }
  if (!seen.has(currentBoardId)) {
    const s = getSession(currentBoardId)
    items.push({
      board: currentBoardId,
      title: s.title,
      version: s.version,
      elements: 0,
      updatedAt: new Date().toISOString(),
      active: true
    })
  }
  items.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    return b.updatedAt.localeCompare(a.updatedAt)
  })
  return items
}

async function flushOutgoingScene(
  boardId: string,
  opts: { outgoingSceneJson?: string; updateRenderer?: boolean }
): Promise<void> {
  if (typeof opts.outgoingSceneJson === 'string') {
    await acceptScene(opts.outgoingSceneJson, boardId)
  } else if (opts.updateRenderer && win && !win.isDestroyed()) {
    const snap = await takeSnapshot(false)
    await acceptScene(snap.sceneJson, boardId)
  }
}

async function switchBoard(
  targetRaw: string,
  opts: {
    title?: string
    createOnly?: boolean
    requireExisting?: boolean
    outgoingSceneJson?: string
    updateRenderer?: boolean
  } = {}
): Promise<{
  board: string
  title: string | null
  version: number
  path: string
  json: string | null
  created: boolean
  boards: BoardInfo[]
  hubState: HubState
}> {
  const targetId = opts.requireExisting ? validateBoardId(targetRaw) : normalizeBoardId(targetRaw)
  const targetPath = boardFilePath(BOARDS_DIR, targetId)
  const exists = existsSync(targetPath)
  if (opts.createOnly && exists) throw new Error(`画板「${targetId}」已存在`)
  if (opts.requireExisting && !exists && targetId !== currentBoardId) {
    throw new Error(`Board "${targetId}" does not exist. Call canvas_open with board "${targetId}" to create it first.`)
  }

  const prevBoardId = currentBoardId
  const switching = targetId !== prevBoardId
  if (switching) await flushOutgoingScene(prevBoardId, opts)

  const nextTitle = normalizeBoardTitle(opts.title) ?? undefined
  if (!exists) {
    await atomicWriteJson(targetPath, emptyBoardScene({ title: nextTitle }))
  } else if (nextTitle !== undefined) {
    try {
      const updated = updateBoardSceneTitle(await readFile(targetPath, 'utf8'), nextTitle)
      await atomicWriteJson(targetPath, JSON.parse(updated))
    } catch {}
  }

  currentBoardId = targetId
  persistCurrentBoard()
  const loaded = await loadBoard(targetId)
  updateWindowTitle()
  pushHubState()

  if (opts.updateRenderer && switching && win && !win.isDestroyed()) {
    await rpc('loadScene', { board: targetId, title: loaded.title, version: loaded.version, json: loaded.json })
  }

  return {
    board: loaded.board,
    title: loaded.title,
    version: loaded.version,
    path: loaded.path,
    json: loaded.json,
    created: !exists,
    boards: await listBoards(),
    hubState: getSession(targetId).hub.state()
  }
}

async function renameBoard(
  rawFrom: string | undefined,
  rawTo: string,
  opts: {
    title?: string | null
    outgoingSceneJson?: string
    updateRenderer?: boolean
  } = {}
): Promise<{
  oldBoard: string
  board: string
  title: string | null
  version: number
  path: string
  json: string | null
  boards: BoardInfo[]
  hubState: HubState
}> {
  const fromId = rawFrom?.trim() ? validateBoardId(rawFrom) : currentBoardId
  const toId = normalizeBoardId(rawTo)
  const fromPath = boardFilePath(BOARDS_DIR, fromId)
  const toPath = boardFilePath(BOARDS_DIR, toId)

  if (fromId === currentBoardId) await flushOutgoingScene(fromId, opts)
  const fromExists = existsSync(fromPath)
  if (!fromExists && fromId !== currentBoardId) {
    throw new Error(`画板「${fromId}」不存在`)
  }
  if (toId !== fromId && existsSync(toPath)) {
    throw new Error(`画板「${toId}」已存在`)
  }

  const rawJson = fromExists ? await readFile(fromPath, 'utf8') : JSON.stringify(emptyBoardScene())
  const nextTitle = opts.title !== undefined ? normalizeBoardTitle(opts.title) : null
  const updatedScene = JSON.parse(updateBoardSceneTitle(rawJson, nextTitle)) as Record<string, unknown>
  await atomicWriteJson(toPath, updatedScene)
  if (toId !== fromId && fromExists) await unlink(fromPath)

  const oldSession = sessions.get(fromId)
  if (toId !== fromId && oldSession) {
    sessions.delete(fromId)
    oldSession.id = toId
    sessions.set(toId, oldSession)
    for (const [reqId, bId] of requestBoard) {
      if (bId === fromId) requestBoard.set(reqId, toId)
    }
  }
  const targetSession = getSession(toId)
  targetSession.title = nextTitle

  if (currentBoardId === fromId && toId !== fromId) {
    currentBoardId = toId
    persistCurrentBoard()
  }
  persistPending()

  const loaded = await loadBoard(toId)
  updateWindowTitle()
  if (toId === currentBoardId) pushHubState()

  const boards = await listBoards()
  const hubState = getSession(currentBoardId).hub.state()
  if (opts.updateRenderer && win && !win.isDestroyed()) {
    await rpc('syncBoards', {
      board: currentBoardId,
      title: getSession(currentBoardId).title,
      version: getSession(currentBoardId).version,
      boards,
      hubState
    })
  }

  return {
    oldBoard: fromId,
    board: loaded.board,
    title: loaded.title,
    version: loaded.version,
    path: loaded.path,
    json: loaded.json,
    boards,
    hubState
  }
}

async function deleteBoard(
  rawBoard: string | undefined,
  opts: { outgoingSceneJson?: string; updateRenderer?: boolean } = {}
): Promise<{
  deleted: string
  board: string
  title: string | null
  version: number
  path: string
  json: string | null
  boards: BoardInfo[]
  hubState: HubState
}> {
  const targetId = rawBoard?.trim() ? validateBoardId(rawBoard) : currentBoardId
  const all = await listBoards()
  if (!all.some((b) => b.board === targetId)) {
    throw new Error(`画板「${targetId}」不存在`)
  }
  const remaining = all.filter((b) => b.board !== targetId)
  if (!remaining.length) {
    throw new Error('至少保留一块画板，不能删除最后一块画板')
  }

  if (targetId !== currentBoardId) await flushOutgoingScene(currentBoardId, opts)

  const targetPath = boardFilePath(BOARDS_DIR, targetId)
  if (existsSync(targetPath)) await unlink(targetPath)

  const oldSession = sessions.get(targetId)
  if (oldSession) {
    oldSession.hub.cancelAll()
    sessions.delete(targetId)
  }
  for (const [reqId, bId] of [...requestBoard]) {
    if (bId === targetId) requestBoard.delete(reqId)
  }
  persistPending()

  const deletedActive = targetId === currentBoardId
  if (deletedActive) {
    const nextId = pickFallbackBoard(remaining)
    if (!nextId) throw new Error('至少保留一块画板，不能删除最后一块画板')
    currentBoardId = nextId
    persistCurrentBoard()
  }

  const loaded = await loadBoard(currentBoardId)
  updateWindowTitle()
  pushHubState()
  const boards = await listBoards()
  const hubState = getSession(currentBoardId).hub.state()

  if (opts.updateRenderer && win && !win.isDestroyed()) {
    if (deletedActive) {
      await rpc('loadScene', { board: loaded.board, title: loaded.title, version: loaded.version, json: loaded.json })
    } else {
      await rpc('syncBoards', { board: loaded.board, title: loaded.title, version: loaded.version, boards, hubState })
    }
  }

  return {
    deleted: targetId,
    board: loaded.board,
    title: loaded.title,
    version: loaded.version,
    path: loaded.path,
    json: loaded.json,
    boards,
    hubState
  }
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
    title: 'Flying draws',
    // 不用系统自带的标题栏和菜单栏：顶上那一条由页面自己画成纸色，只留系统的最小化/最大化/关闭按钮
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...TITLEBAR_COLORS.light, height: TITLEBAR_HEIGHT },
    backgroundColor: TITLEBAR_COLORS.light.color,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })
  const overlayTarget = win
  ipcMain.removeAllListeners('window:theme')
  ipcMain.on('window:theme', (_e, theme: unknown) => {
    if (overlayTarget.isDestroyed()) return
    const colors = theme === 'dark' ? TITLEBAR_COLORS.dark : TITLEBAR_COLORS.light
    // 只有 Windows 和 Linux 上能改这几个按钮的颜色
    if (process.platform !== 'darwin') overlayTarget.setTitleBarOverlay({ ...colors, height: TITLEBAR_HEIGHT })
    overlayTarget.setBackgroundColor(colors.color)
  })
  ipcMain.removeAllListeners('window:reload')
  ipcMain.on('window:reload', () => {
    if (!overlayTarget.isDestroyed()) overlayTarget.webContents.reload()
  })
  ipcMain.removeAllListeners('window:devtools')
  ipcMain.on('window:devtools', () => {
    if (!overlayTarget.isDestroyed()) overlayTarget.webContents.toggleDevTools()
  })
  windowReady = new Promise((resolve) => ipcMain.once('renderer:ready', () => resolve()))
  updateWindowTitle()

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
  if (win && !win.isDestroyed()) win.webContents.send('hub:state', getSession(currentBoardId).hub.state())
}

// ---------- 还在等用户回应的请求与未取走的收件箱：存盘，重启后恢复 ----------
// 不存的话，应用重启后横幅没了，提议层上的元素却还留在画布上，没有按钮可以确认；
// 用户主动"发给 agent"的画如果还在收件箱里，重启也会丢失。

let lastPendingKey = '#'

function pendingStateKey(boards: Record<string, DrawRequest[]>, inbox: Record<string, Submission[]>): string {
  const reqKey = Object.entries(boards)
    .filter(([, list]) => list.length > 0)
    .map(([id, list]) => `${id}:${list.map((r) => r.id).join(',')}`)
    .sort()
    .join('|')
  const inboxKey = Object.entries(inbox)
    .filter(([, list]) => list.length > 0)
    .map(([id, list]) => `${id}:${list.map((s) => `${s.at}:${s.version}`).join(',')}`)
    .sort()
    .join('|')
  return `${reqKey}#${inboxKey}`
}

function persistPending(): void {
  const boards: Record<string, DrawRequest[]> = {}
  const inbox: Record<string, Submission[]> = {}
  for (const [id, session] of sessions) {
    const waiting = session.hub.waiting()
    if (waiting.length) boards[id] = waiting
    const queued = session.hub.queuedInbox()
    if (queued.length) inbox[id] = queued
  }
  const key = pendingStateKey(boards, inbox)
  if (key === lastPendingKey) return // 只是有 agent 开始或结束等待，请求和收件箱本身没变
  lastPendingKey = key
  try {
    mkdirSync(HOME, { recursive: true })
    const tmp = `${pendingPath}.tmp`
    const payload = { version: 2, boards, ...(Object.keys(inbox).length ? { inbox } : {}) }
    // 同步原子写盘，保证应用被强杀前已落盘且不留半截文件
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, pendingPath)
  } catch (err) {
    console.error('[flyingdraws] could not save pending requests:', err)
  }
}

function restorePending(): void {
  let perBoard: Record<string, DrawRequest[]> = {}
  let perInbox: Record<string, Submission[]> = {}
  try {
    const raw = JSON.parse(readFileSync(pendingPath, 'utf8')) as {
      version?: number
      board?: string
      requests?: DrawRequest[]
      boards?: Record<string, DrawRequest[]>
      inbox?: Record<string, Submission[]>
    }
    if (raw.version === 2) {
      if (raw.boards && typeof raw.boards === 'object') perBoard = raw.boards
      if (raw.inbox && typeof raw.inbox === 'object') perInbox = raw.inbox
    } else if (Array.isArray(raw.requests)) {
      perBoard = { [raw.board && isValidBoardId(raw.board) ? raw.board : DEFAULT_BOARD_ID]: raw.requests }
    }
  } catch {
    return // 没有存过，或者文件坏了：当作没有待处理的请求
  }
  const restoredBoards: Record<string, DrawRequest[]> = {}
  const restoredInbox: Record<string, Submission[]> = {}
  const allBoardIds = new Set([...Object.keys(perBoard), ...Object.keys(perInbox)])
  for (const boardId of allBoardIds) {
    if (!isValidBoardId(boardId)) continue
    const boardPath = boardFilePath(BOARDS_DIR, boardId)
    const boardExists = existsSync(boardPath)
    if (!boardExists && boardId !== currentBoardId) continue
    const saved = Array.isArray(perBoard[boardId]) ? perBoard[boardId] : []
    const savedInbox = Array.isArray(perInbox[boardId]) ? perInbox[boardId] : []
    // 提议对应的元素要是已经不在画板上了（比如用户手动删光了），这个提议就不用再问
    let proposalsOnBoard = new Set<string>()
    if (boardExists) {
      try {
        const elements = (JSON.parse(readFileSync(boardPath, 'utf8')).elements ?? []) as DiffElement[]
        proposalsOnBoard = new Set(
          elements.filter((el) => !el.isDeleted && el.customData?.flyingdraws?.layer === 'proposal').map((el) => String(el.customData?.flyingdraws?.proposal))
        )
      } catch {}
    }
    const usable = saved.filter((r) => r && typeof r.id === 'string' && (r.kind !== 'proposal' || (r.proposalId && proposalsOnBoard.has(r.proposalId))))
    const usableInbox = savedInbox.filter((s) => s && typeof s.sceneJson === 'string' && typeof s.at === 'string')
    if (!usable.length && !usableInbox.length) continue
    if (usable.length) restoredBoards[boardId] = usable
    if (usableInbox.length) restoredInbox[boardId] = usableInbox
    for (const r of usable) requestBoard.set(r.id, boardId)
    getSession(boardId).hub.restore(usable, usableInbox)
  }
  lastPendingKey = pendingStateKey(restoredBoards, restoredInbox)
}

// ---------- 给 agent 的响应 ----------

type ImageMode = 'auto' | 'always' | 'never'

// ---------- 每个版本的节点对照表 ----------
// agent 拿到的每一份画板描述，都记下当时"编号 → 元素"的对照和每个元素的指纹。
// agent 之后带着 base_version 来画时，用它把旧编号换算成现在的元素，并判断它要改的东西有没有被别人动过。
// 只放在内存里：应用重启后查不到旧版本，agent 会被要求重新读一次。

type VersionedElement = SceneElement & { version?: number }

// 元素的指纹：它自己的 version 加上绑在它上面的文字的 version。任何一个变了，说明这个元素被动过。
function fingerprints(elements: readonly VersionedElement[]): Map<string, string> {
  const textVersion = new Map<string, number>()
  for (const el of elements) {
    if (!el.isDeleted && el.type === 'text' && el.containerId) textVersion.set(el.containerId, el.version ?? 0)
  }
  const out = new Map<string, string>()
  for (const el of elements) if (!el.isDeleted) out.set(el.id, `${el.version ?? 0}:${textVersion.get(el.id) ?? ''}`)
  return out
}

function remember(boardId: string, ver: number, elements: readonly VersionedElement[], graph: ReturnType<typeof buildGraph>): void {
  const history = getSession(boardId).history
  history.delete(ver)
  history.set(ver, { nodes: graph.nodes.map(({ id, ref, label }) => ({ id, ref, label })), fingerprints: fingerprints(elements) })
  while (history.size > HISTORY_LIMIT) history.delete(history.keys().next().value as number)
}

function describe(sceneJson: string, ver: number, opts: { format: string; image: ImageMode }, png: string | null, boardId = currentBoardId) {
  const scene = JSON.parse(sceneJson)
  const graph = buildGraph((scene.elements ?? []) as SceneElement[])
  remember(boardId, ver, (scene.elements ?? []) as VersionedElement[], graph)
  let summary = summarize(graph, { board: boardId, version: ver })
  const wantImage = opts.image === 'always' || (opts.image === 'auto' && graph.needsImage)
  const attached = wantImage && Boolean(png)
  if (graph.needsImage) {
    summary += attached
      ? '\n提示：有文字描述不了的内容（手写、涂鸦、图片或线条），已附画布截图。'
      : '\n提示：有文字描述不了的内容（手写、涂鸦、图片或线条），需要的话用 image: "always" 再读一次拿截图。'
  }
  return {
    board: boardId,
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

// 请求指定了 board 且不是当前画板时，先切换过去（要求已存在）
async function ensureBoard(rawBoard: unknown): Promise<string> {
  if (typeof rawBoard !== 'string' || !rawBoard.trim()) return currentBoardId
  const targetId = validateBoardId(rawBoard)
  if (targetId === currentBoardId) return currentBoardId
  if (!win || win.isDestroyed()) bringToFront()
  await windowReady
  await switchBoard(targetId, { requireExisting: true, updateRenderer: true })
  return targetId
}

// /draw 和 /propose 共用：把一批指令画到画布上。proposalId 不为空时画在提议层上。
// 要在 serialized() 里面调用。
async function drawOps(
  body: Record<string, unknown>,
  proposalId: string | null
): Promise<{ ok: boolean; result: Record<string, unknown>; sceneJson?: string; boardId: string }> {
  const boardId = await ensureBoard(body.board)
  const session = getSession(boardId)
  // 先拿页面上的最新状态，版本号以它为准（用户刚画的几笔可能还没落盘）
  const snap = await takeSnapshot(false)
  const ver = await acceptScene(snap.sceneJson, boardId)
  const elements = (JSON.parse(snap.sceneJson).elements ?? []) as VersionedElement[]
  const graph = buildGraph(elements)
  const current = () => describe(snap.sceneJson, ver, { format: 'summary', image: 'never' }, null, boardId)
  const fail = (status: 'invalid' | 'conflict', message: string) => ({ ok: false, boardId, result: { status, error: message, ...current() } })

  let ops = (Array.isArray(body.ops) ? body.ops : []) as DrawOp[]
  if (proposalId && ops.some((op) => MODIFY_OPS.includes(op?.op))) {
    return fail('invalid', 'A proposal can only add things (add_node, add_edge, add_text). Use canvas_draw to change or delete what you drew.')
  }

  // agent 是基于哪个版本下的指令。和当前版本不一样时，先把指令里的旧编号换算成现在的。
  const base = Number(body.base_version)
  const record = base !== ver ? session.history.get(base) : undefined
  const nameAt = (id: string) => {
    const label = record?.nodes.find((n) => n.id === id)?.label
    return label ? `${id} ("${label}")` : id
  }
  if (record) {
    const rebased = rebaseOps(ops, record.nodes, graph)
    if (rebased.gone.length) {
      return fail('conflict', `${rebased.gone.map(nameAt).join(', ')} ${rebased.gone.length > 1 ? 'were' : 'was'} deleted after version ${base}.`)
    }
    ops = rebased.ops
  }

  let plan: DrawPlan
  try {
    plan = planOps(ops, graph, newElementId, { direction: body.direction === 'down' ? 'down' : 'right' })
  } catch (err) {
    if (err instanceof OpsError) return fail('invalid', err.message)
    throw err
  }

  // 只新增、不引用已有节点的指令在任何版本上都能执行。引用了已有节点时：
  if (plan.existingRefs.length && base !== ver) {
    if (!record) {
      // 查不到 agent 读的那个版本，编号没法换算
      return fail(
        'conflict',
        Number.isFinite(base)
          ? `The canvas has no record of version ${base} (the app may have restarted, or that read is too old), so node ids like N1 cannot be trusted.`
          : 'These ops refer to nodes already on the canvas, so base_version is required.'
      )
    }
    // 引用的节点只要还在就行；但要改动或删除的元素，从那个版本到现在不能被别人动过（design.md 12.3）
    const now = fingerprints(elements)
    const touched = plan.modifiedRefs.filter((ref) => record.fingerprints.get(ref) !== now.get(ref))
    if (touched.length) {
      const names = touched.map((ref) => {
        const node = graph.nodes.find((n) => n.ref === ref)
        return node ? `${node.id}${node.label ? ` ("${node.label}")` : ''}` : 'an arrow'
      })
      return fail('conflict', `${names.join(', ')} ${touched.length > 1 ? 'were' : 'was'} changed by someone else after version ${base}.`)
    }
  }

  const applied = await rpc<{ sceneJson: string }>('applyPlan', { plan, proposalId }, 12_000)
  const newVer = await acceptScene(applied.sceneJson, boardId)
  const after = buildGraph((JSON.parse(applied.sceneJson).elements ?? []) as SceneElement[])
  const nodeIds: Record<string, string> = {}
  for (const n of plan.nodes) {
    const node = after.nodes.find((x) => x.ref === n.elementId)
    if (node) nodeIds[n.key] = node.id
  }
  return {
    ok: true,
    boardId,
    sceneJson: applied.sceneJson,
    result: {
      added: { nodes: plan.nodes.length, edges: plan.edges.length, texts: plan.texts.length },
      changed: { updated: plan.updates.length, deleted: plan.deletes.length },
      node_ids: nodeIds,
      ...describe(applied.sceneJson, newVer, { format: 'summary', image: 'never' }, null, boardId)
    }
  }
}

const routes = {
  '/open': (body: Record<string, unknown>) =>
    serialized(async () => {
      bringToFront()
      await windowReady
      const rawBoard = typeof body.board === 'string' && body.board.trim() ? body.board : null
      const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined
      if (rawBoard) {
        const switched = await switchBoard(rawBoard, { title, updateRenderer: true })
        return {
          board: switched.board,
          title: switched.title,
          version: switched.version,
          created: switched.created,
          window: 'shown'
        }
      }
      const session = getSession(currentBoardId)
      return { board: currentBoardId, title: session.title, version: session.version, created: false, window: 'shown' }
    }),

  '/list': async () => ({
    current: currentBoardId,
    boards: await listBoards()
  }),

  '/rename': (body: Record<string, unknown>) =>
    serialized(async () => {
      const fromBoard = typeof body.board === 'string' && body.board.trim() ? body.board : undefined
      const rawNew = String(body.new_board ?? '')
      const explicitTitle = body.title === null ? null : typeof body.title === 'string' ? body.title : undefined
      const title = explicitTitle !== undefined ? explicitTitle : /\s/.test(rawNew.trim()) ? rawNew.trim() : null
      const renamed = await renameBoard(fromBoard, rawNew, { title, updateRenderer: true })
      return {
        old_board: renamed.oldBoard,
        board: renamed.board,
        title: renamed.title,
        version: renamed.version
      }
    }),

  '/delete': (body: Record<string, unknown>) =>
    serialized(async () => {
      const targetBoard = typeof body.board === 'string' && body.board.trim() ? body.board : undefined
      const res = await deleteBoard(targetBoard, { updateRenderer: true })
      return {
        deleted: res.deleted,
        current: res.board,
        title: res.title,
        version: res.version
      }
    }),

  '/read': async (body: Record<string, unknown>) => {
    const image = imageMode(body.image)
    if (!win) {
      bringToFront()
    }
    const boardId =
      typeof body.board === 'string' && body.board.trim()
        ? await serialized(() => ensureBoard(body.board))
        : currentBoardId
    // 先不要图，算完语义发现需要时再要，省一次导出
    let snap = await takeSnapshot(image === 'always')
    const ver = await acceptScene(snap.sceneJson, boardId)
    let res = describe(snap.sceneJson, ver, { format: String(body.format ?? 'summary'), image }, snap.pngBase64, boardId)
    if (image === 'auto' && res.needs_image && !snap.pngBase64) {
      snap = await takeSnapshot(true)
      res = describe(snap.sceneJson, ver, { format: String(body.format ?? 'summary'), image }, snap.pngBase64, boardId)
    }
    // 用户之前点过"发给 agent"但还没人来取的，这次读取就算取走了：把附言带上
    const sent = getSession(boardId)
      .hub.takeInbox()
      .map((s) => ({ note: s.note, at: s.at }))
    return { ...res, sent }
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
      const req = getSession(res.boardId).hub.create(question, proposalId, baseline)
      requestBoard.set(req.id, res.boardId)
      bringToFront()
      return { status: 'proposed', request_id: req.id, ...res.result }
    }),

  '/request': (body: Record<string, unknown>) =>
    serialized(async () => {
      const prompt = String(body.prompt ?? '').trim()
      if (!prompt) throw new Error('prompt is required')
      const boardId = await ensureBoard(body.board)
      const req = getSession(boardId).hub.create(prompt)
      requestBoard.set(req.id, boardId)
      bringToFront()
      return { request_id: req.id, board: boardId, status: 'waiting' }
    }),

  '/wait': async (body: Record<string, unknown>) => {
    const seconds = Math.min(Math.max(Number(body.timeout_s) || WAIT_DEFAULT_S, 1), WAIT_MAX_S)
    const requestId = typeof body.request_id === 'string' && body.request_id ? body.request_id : null
    const boardId = requestId
      ? (requestBoard.get(requestId) ?? currentBoardId)
      : typeof body.board === 'string' && body.board.trim()
        ? validateBoardId(body.board)
        : currentBoardId
    const result: WaitResult = await getSession(boardId).hub.wait(requestId ? { requestId } : { inbox: true }, seconds * 1000)
    if (result.status !== 'submitted') return { ...result, request_id: requestId }
    const sub = result.submission
    return {
      status: 'submitted',
      request_id: sub.requestId,
      decision: sub.decision ?? null,
      changes: sub.changes ?? null,
      note: sub.note,
      submitted_at: sub.at,
      ...describe(sub.sceneJson, sub.version, { format: String(body.format ?? 'summary'), image: imageMode(body.image) }, sub.pngBase64, boardId)
    }
  }
}

// ---------- 页面发来的调用 ----------

ipcMain.handle('board:load', async () => {
  const loaded = await loadBoard(currentBoardId)
  return { ...loaded, boards: await listBoards() }
})
ipcMain.handle('board:list', async () => ({ current: currentBoardId, boards: await listBoards() }))
ipcMain.handle('board:save', async (_e, json: unknown) => {
  if (typeof json !== 'string') throw new Error('board:save expects a JSON string')
  const ver = await acceptScene(json, currentBoardId)
  return { board: currentBoardId, path: boardFilePath(BOARDS_DIR, currentBoardId), saveCount, version: ver, savedAt: new Date().toISOString() }
})
ipcMain.handle('board:create', (_e, payload: { name: string; title?: string; currentSceneJson?: string }) =>
  serialized(() =>
    switchBoard(payload.name, {
      title: payload.title,
      createOnly: true,
      outgoingSceneJson: payload.currentSceneJson
    })
  )
)
ipcMain.handle('board:switch', (_e, payload: { board: string; currentSceneJson?: string }) =>
  serialized(() =>
    switchBoard(payload.board, {
      requireExisting: true,
      outgoingSceneJson: payload.currentSceneJson
    })
  )
)
ipcMain.handle('board:rename', (_e, payload: { board?: string; name: string; title?: string | null; currentSceneJson?: string }) =>
  serialized(() =>
    renameBoard(payload.board, payload.name, {
      title: payload.title,
      outgoingSceneJson: payload.currentSceneJson
    })
  )
)
ipcMain.handle('board:delete', (_e, payload: { board: string; currentSceneJson?: string }) =>
  serialized(() =>
    deleteBoard(payload.board, {
      outgoingSceneJson: payload.currentSceneJson
    })
  )
)
ipcMain.handle('board:reveal', () => {
  const p = boardFilePath(BOARDS_DIR, currentBoardId)
  if (existsSync(p)) return shell.showItemInFolder(p)
  mkdirSync(BOARDS_DIR, { recursive: true })
  return shell.openPath(BOARDS_DIR)
})
ipcMain.handle('hub:state', () => getSession(currentBoardId).hub.state())
type SubmitPayload = { requestId: string | null; note: string; sceneJson: string; pngBase64: string | null; decision?: 'accepted' | 'rejected' | null }
ipcMain.handle('hub:submit', async (_e, payload: SubmitPayload) => {
  const boardId = currentBoardId
  const hub = getSession(boardId).hub
  const ver = await acceptScene(payload.sceneJson, boardId)
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
ipcMain.handle('hub:cancel', (_e, requestId: string) => {
  const boardId = requestBoard.get(requestId) ?? currentBoardId
  return getSession(boardId).hub.cancel(requestId)
})

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
