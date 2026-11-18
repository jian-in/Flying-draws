import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { bboxOf, buildGraph, summarize, type SceneElement, type SceneFile } from './semantic'
import {
  OpsError,
  elementFingerprints,
  planOps,
  rebaseOps,
  toProposalPlan,
  type DrawOp,
  type DrawPlan,
  type FingerprintElement,
  type PendingChanges
} from './ops'
import { pickupHint, RequestHub, type HubState, type Submission, type WaitResult } from './requests'
import { PendingStore } from './pending'
import { SEAT_COLORS, nextSeatColor, SeatRegistry } from './seats'
import { atomicWriteJson } from './atomicWrite'
import { captureBaseline, diffProposal, type DiffElement, type ProposalBaseline } from './diff'
import { createDaemonLifecycle, startDaemon } from './daemon'
import { WindowDock, type DockState } from './dock'
import { registerAgent } from './agentIpc'
import { trayIconPixels } from './trayIcon'
import { freshApprovals, hasPendingApprovals, trayTooltip } from './agentNotice'
import { AGENT_SEAT, type AgentState } from '../shared/agent'
import {
  BOARD_EXT,
  DEFAULT_BOARD_ID,
  boardFilePath,
  emptyBoardScene,
  isValidBoardId,
  matchExistingBoardId,
  normalizeBoardId,
  normalizeBoardTitle,
  parseBoardMeta,
  pickFallbackBoard,
  sameBoardOnDisk,
  updateBoardSceneTitle,
  validateBoardId,
  type BoardMeta
} from './boards'

// 设了 FLYINGDRAWS_HOME 就把画板、连接信息和 Electron 自己的数据都放到那个目录下。
// 测试用它开一个和用户画板完全隔离的实例（单实例锁也是按 userData 目录算的）。
const HOME = resolve(process.env['FLYINGDRAWS_HOME'] || join(homedir(), '.flyingdraws'))
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
const agent = registerAgent(HOME, () => win, () => currentBoardId)

// ---------- 后台常驻 ----------
// 关窗口只是把窗口藏起来：页面还活着，画布读写、内置 Agent 和外部 agent 的连接都照常工作。
// 真正退出走托盘菜单的「退出」（或系统注销/关机）。隔离的测试实例不常驻，关窗口照旧退出。
const BACKGROUND_ARG = '--background'
const TEST_INSTANCE = Boolean(process.env['FLYINGDRAWS_HOME'] && process.env['FLYINGDRAWS_DEBUG_PORT'])
let tray: Tray | null = null
let quitting = false
let backgroundHintShown = false
// 开机自启时带着 --background，第一次只建窗口不显示
let launchHidden = process.argv.includes(BACKGROUND_ARG)

function trayImage(alert = false): Electron.NativeImage {
  const image = nativeImage.createEmpty()
  for (const [size, scaleFactor] of [[16, 1], [24, 1.5], [32, 2]] as const) {
    image.addRepresentation({ width: size, height: size, scaleFactor, buffer: trayIconPixels(size, alert) })
  }
  return image
}

// 开机自启只在打包后的应用里提供：开发时注册的会是 electron.exe；自定义数据目录的实例开机时也带不上那个目录
const loginItemSupported = (): boolean => app.isPackaged && !process.env['FLYINGDRAWS_HOME']
const openAtLogin = (): boolean =>
  loginItemSupported() && app.getLoginItemSettings({ args: [BACKGROUND_ARG] }).openAtLogin

function refreshTrayMenu(): void {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Flying draws', click: () => bringToFront() },
    { type: 'separator' },
    {
      label: '开机时在后台启动',
      type: 'checkbox',
      checked: openAtLogin(),
      enabled: loginItemSupported(),
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: [BACKGROUND_ARG] })
        refreshTrayMenu()
      }
    },
    { type: 'separator' },
    { label: '退出 Flying draws', click: () => { quitting = true; app.quit() } }
  ]))
}

function createTray(): void {
  if (tray || TEST_INSTANCE) return
  tray = new Tray(trayImage())
  tray.setToolTip('Flying draws')
  tray.on('click', () => bringToFront())
  tray.on('balloon-click', () => bringToFront())
  refreshTrayMenu()
  // 托盘提示跟着内置 Agent 的状态走：藏在后台时也看得出它是在干活还是在等你确认。
  // 等审批时窗口不在眼前（藏着、最小化或在别的窗口后面），弹一条提醒，免得任务无声地挂着。
  const notified = new Set<string>()
  let alerting = false
  agent.on('state', (state: AgentState) => {
    tray?.setToolTip(trayTooltip(state))
    // 托盘图标的红点不依赖系统通知：通知被关掉时也看得见
    const alert = hasPendingApprovals(state)
    if (tray && alert !== alerting) {
      alerting = alert
      tray.setImage(trayImage(alert))
    }
    const fresh = freshApprovals(state, notified)
    const away = !win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || !win.isFocused()
    if (!fresh.length || !away || !tray || process.platform !== 'win32') return
    tray.displayBalloon({
      iconType: 'info',
      title: `${AGENT_SEAT} 等你确认`,
      content: `${fresh.join('、')}：点这里打开 Flying draws 处理。确认前任务会一直等着。`
    })
  })
}

/** 隐藏到后台；页面不降频，画布读写和 Agent 回填照常及时。 */
function hideToBackground(target: BrowserWindow): void {
  target.webContents.setBackgroundThrottling(false)
  target.hide()
  if (backgroundHintShown || !tray) return
  backgroundHintShown = true
  if (process.platform === 'win32') {
    tray.displayBalloon({
      iconType: 'info',
      title: 'Flying draws 还在后台运行',
      content: '内置 Agent 和画布连接都保持可用。点托盘图标打开，右键菜单里可以退出。'
    })
  }
}
if (process.env['FLYINGDRAWS_HOME'] && process.env['FLYINGDRAWS_DEBUG_PORT']) {
  ipcMain.handle('test:capture-window', async () => {
    if (!win || win.isDestroyed()) throw new Error('测试窗口未就绪')
    return (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')
  })
}

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
  seats: Map<string, string>
  drawnAgents: Set<string>
}

interface BoardInfo extends BoardMeta {
  active: boolean
}

const sessions = new Map<string, BoardSession>()
const seatRegistry = new SeatRegistry()
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
    const session: BoardSession = {
      id,
      title: null,
      version: 0,
      lastElementsKey: null,
      hub,
      history: new Map(),
      seats: new Map(),
      drawnAgents: new Set()
    }
    hub.onChange(() => {
      if (session.id === currentBoardId) pushHubState()
      persistPending()
    })
    hub.onEvict((requestId) => requestBoard.delete(requestId))
    sessions.set(id, session)
    s = session
  }
  return s
}

function syncBoardSeats(boardId: string, elements: readonly SceneElement[]): void {
  const session = getSession(boardId)
  const drawn = new Set<string>()
  for (const el of elements) {
    if (el.isDeleted) continue
    const mark = el.customData?.flyingdraws
    if (mark?.role === 'marker' || mark?.author !== 'agent') continue
    if (typeof mark.agent === 'string' && mark.agent) {
      drawn.add(mark.agent)
      if (!session.seats.has(mark.agent)) {
        const existingColor =
          typeof mark.color === 'string' && mark.color ? mark.color : nextSeatColor(session.seats.values(), session.seats.size)
        session.seats.set(mark.agent, existingColor)
      }
    }
  }
  session.drawnAgents = drawn
}

const allWaitingAgents = (): string[] => [...sessions.values()].flatMap((s) => s.hub.state().waitingAgents)

function buildHubState(boardId = currentBoardId): HubState {
  const session = getSession(boardId)
  const base = session.hub.state()
  return {
    ...base,
    onlineSeats: seatRegistry.list({
      boardSeats: session.seats,
      drawnNames: session.drawnAgents,
      waitingAgents: base.waitingAgents
    })
  }
}

seatRegistry.onChange(() => pushHubState())
setInterval(() => {
  if (seatRegistry.hasEntries()) seatRegistry.prune(allWaitingAgents())
}, 30_000).unref()

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
    syncBoardSeats(id, (scene.elements ?? []) as SceneElement[])
    return { board: id, title: session.title, version: session.version, json, path }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      session.version = 0
      session.lastElementsKey = null
      session.drawnAgents = new Set()
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
  syncBoardSeats(id, (scene.elements ?? []) as SceneElement[])
  const key = elementsKey(scene.elements ?? [])
  if (key === session.lastElementsKey) return session.version
  session.lastElementsKey = key
  session.version += 1
  scene.flyingdraws = { version: session.version, ...(session.title ? { title: session.title } : {}) }
  await atomicWriteJson(path, scene)
  saveCount += 1
  if (id === currentBoardId) pushHubState()
  return session.version
}

async function listDiskBoardIds(): Promise<string[]> {
  let entries: string[] = []
  try {
    entries = await readdir(BOARDS_DIR)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const out: string[] = []
  for (const name of entries) {
    if (!name.endsWith(BOARD_EXT)) continue
    const id = name.slice(0, -BOARD_EXT.length)
    if (isValidBoardId(id)) out.push(id)
  }
  return out
}

async function resolveExistingBoardId(id: string): Promise<string | null> {
  const diskIds = await listDiskBoardIds()
  const candidates = diskIds.some((x) => sameBoardOnDisk(x, currentBoardId)) ? diskIds : [...diskIds, currentBoardId]
  return matchExistingBoardId(id, candidates)
}

async function listBoards(): Promise<BoardInfo[]> {
  const items: BoardInfo[] = []
  const diskIds = await listDiskBoardIds()
  const seen = new Set<string>()
  for (const id of diskIds) {
    seen.add(id)
    const active = sameBoardOnDisk(id, currentBoardId)
    if (active && id !== currentBoardId) currentBoardId = id
    const file = boardFilePath(BOARDS_DIR, id)
    try {
      const [json, st] = await Promise.all([readFile(file, 'utf8'), stat(file)])
      items.push({ ...parseBoardMeta(id, json, st.mtime.toISOString()), active: id === currentBoardId })
    } catch {}
  }
  if (![...seen].some((id) => sameBoardOnDisk(id, currentBoardId))) {
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
  const parsedId = opts.requireExisting ? validateBoardId(targetRaw) : normalizeBoardId(targetRaw)
  const matchedExisting = await resolveExistingBoardId(parsedId)
  const targetId = matchedExisting ?? parsedId
  const targetPath = boardFilePath(BOARDS_DIR, targetId)
  const exists = existsSync(targetPath)
  if (opts.createOnly && (exists || matchedExisting)) throw new Error(`画板「${targetId}」已存在`)
  if (opts.requireExisting && !exists && targetId !== currentBoardId) {
    throw new Error(`Board "${parsedId}" does not exist. Call canvas_open with board "${parsedId}" to create it first.`)
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
    hubState: buildHubState(targetId)
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
  const rawFromId = rawFrom?.trim() ? validateBoardId(rawFrom) : currentBoardId
  const fromId = (await resolveExistingBoardId(rawFromId)) ?? rawFromId
  const toId = normalizeBoardId(rawTo)
  const existingCollision = !sameBoardOnDisk(fromId, toId) ? await resolveExistingBoardId(toId) : null
  return agent.withBoardChange(fromId, async () => {
  const fromPath = boardFilePath(BOARDS_DIR, fromId)
  const toPath = boardFilePath(BOARDS_DIR, toId)

  if (fromId === currentBoardId) await flushOutgoingScene(fromId, opts)
  const fromExists = existsSync(fromPath)
  if (!fromExists && fromId !== currentBoardId) {
    throw new Error(`画板「${rawFromId}」不存在`)
  }
  if (!sameBoardOnDisk(fromId, toId) && (existingCollision || existsSync(toPath))) {
    throw new Error(`画板「${existingCollision ?? toId}」已存在`)
  }

  const rawJson = fromExists ? await readFile(fromPath, 'utf8') : JSON.stringify(emptyBoardScene())
  const nextTitle = opts.title !== undefined ? normalizeBoardTitle(opts.title) : null
  const updatedScene = JSON.parse(updateBoardSceneTitle(rawJson, nextTitle)) as Record<string, unknown>
  if (fromId !== toId && sameBoardOnDisk(fromId, toId) && fromExists) {
    // 大小写不敏感文件系统上的纯大小写改名：先写临时文件，删旧名，再改名到新大小写
    const caseTmp = `${toPath}.case.${process.pid}.tmp`
    await atomicWriteJson(caseTmp, updatedScene)
    await unlink(fromPath)
    await rename(caseTmp, toPath)
  } else {
    await atomicWriteJson(toPath, updatedScene)
    if (toId !== fromId && fromExists) await unlink(fromPath)
  }

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

  await agent.renameBoard(fromId, toId)
  const loaded = await loadBoard(toId)
  updateWindowTitle()
  if (toId === currentBoardId) pushHubState()

  const boards = await listBoards()
  const hubState = buildHubState(currentBoardId)
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
  })
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
  const rawTargetId = rawBoard?.trim() ? validateBoardId(rawBoard) : currentBoardId
  const targetId = (await resolveExistingBoardId(rawTargetId)) ?? rawTargetId
  return agent.withBoardChange(targetId, async () => {
  const all = await listBoards()
  if (!all.some((b) => b.board === targetId)) {
    throw new Error(`画板「${rawTargetId}」不存在`)
  }
  const remaining = all.filter((b) => b.board !== targetId)
  if (!remaining.length) {
    throw new Error('至少保留一块画板，不能删除最后一块画板')
  }

  if (targetId !== currentBoardId) await flushOutgoingScene(currentBoardId, opts)

  const targetPath = boardFilePath(BOARDS_DIR, targetId)
  if (existsSync(targetPath)) await unlink(targetPath)
  await agent.deleteBoard(targetId)

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
  const hubState = buildHubState(currentBoardId)

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
  })
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

function rejectPendingRpcs(reason: string): void {
  const err = new Error(reason)
  for (const [, p] of rpcPending) {
    clearTimeout(p.timer)
    p.reject(err)
  }
  rpcPending.clear()
}

interface Snapshot {
  board?: string
  sceneJson: string
  pngBase64: string | null
  view?: { x: number; y: number; w: number; h: number } | null // 用户当前看得见的那块画布
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
  setTimeout(() => {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(false)
  }, 300)
}

let windowReady: Promise<void> = Promise.resolve()
let dock: WindowDock | null = null

function createWindow(): void {
  win = new BrowserWindow({
    show: !launchHidden && !(process.env['FLYINGDRAWS_HOME'] && process.env['FLYINGDRAWS_DEBUG_PORT'] && process.env['FLYINGDRAWS_TEST_HIDDEN'] === '1'),
    width: 1280,
    height: 820,
    title: 'Flying draws',
    // 不用系统自带的标题栏和菜单栏：顶上那一条由页面自己画成纸色，只留系统的最小化/最大化/关闭按钮
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...TITLEBAR_COLORS.light, height: TITLEBAR_HEIGHT },
    backgroundColor: TITLEBAR_COLORS.light.color,
    autoHideMenuBar: true,
    webPreferences: {
      backgroundThrottling: !(process.env['FLYINGDRAWS_HOME'] && process.env['FLYINGDRAWS_DEBUG_PORT']),
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })
  const overlayTarget = win
  // 窗口吸附：拖到别的窗口旁边松手就贴上去，状态变了告诉页面（隔离测试实例不启用系统级吸附）
  dock = TEST_INSTANCE
    ? null
    : new WindowDock(win, (state) => {
        if (!overlayTarget.isDestroyed()) overlayTarget.webContents.send('dock:state', state)
      })
  ipcMain.removeAllListeners('window:theme')
  ipcMain.on('window:theme', (_e, theme: unknown) => {
    if (overlayTarget.isDestroyed()) return
    const colors = theme === 'dark' ? TITLEBAR_COLORS.dark : TITLEBAR_COLORS.light
    // 只有 Windows 和 Linux 上能改这几个按钮的颜色
    if (process.platform !== 'darwin') overlayTarget.setTitleBarOverlay({ ...colors, height: TITLEBAR_HEIGHT })
    overlayTarget.setBackgroundColor(colors.color)
  })
  const armWindowReady = () => {
    ipcMain.removeAllListeners('renderer:ready')
    windowReady = new Promise((resolve) => ipcMain.once('renderer:ready', () => resolve()))
  }
  armWindowReady()
  ipcMain.removeAllListeners('window:reload')
  ipcMain.on('window:reload', () => {
    if (!overlayTarget.isDestroyed()) {
      rejectPendingRpcs('canvas window reloaded')
      armWindowReady()
      overlayTarget.webContents.reload()
    }
  })
  ipcMain.removeAllListeners('window:devtools')
  ipcMain.on('window:devtools', () => {
    if (!overlayTarget.isDestroyed()) overlayTarget.webContents.toggleDevTools()
  })
  updateWindowTitle()

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('closed', () => {
    rejectPendingRpcs('canvas window closed')
    win = null
  })
  if (launchHidden) {
    launchHidden = false
    win.webContents.setBackgroundThrottling(false)
  }
  win.on('close', (event) => {
    if (quitting || !tray) return
    event.preventDefault()
    hideToBackground(overlayTarget)
  })
  win.on('show', () => {
    // 回到前台后恢复默认的后台降频设置（测试实例本来就关着降频）
    overlayTarget.webContents.setBackgroundThrottling(!(process.env['FLYINGDRAWS_HOME'] && process.env['FLYINGDRAWS_DEBUG_PORT']))
  })
  // Windows 注销、关机时没有 before-quit，这里放行关窗口，别挡住系统
  win.on('session-end', () => {
    quitting = true
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function pushHubState(): void {
  if (win && !win.isDestroyed()) win.webContents.send('hub:state', buildHubState(currentBoardId))
}

// ---------- 还在等用户回应的请求与未取走的收件箱：存盘，重启后恢复 ----------
// 不存的话，应用重启后横幅没了，提议层上的元素却还留在画布上，没有按钮可以确认；
// 用户主动"发给 agent"的画如果还在收件箱里，重启也会丢失。

const pendingStore = new PendingStore({
  pendingPath,
  boardsDir: BOARDS_DIR,
  getCurrentBoardId: () => currentBoardId,
  sessions,
  getHub: (boardId) => getSession(boardId).hub,
  onRequestRestored: (requestId, boardId) => requestBoard.set(requestId, boardId)
})

const persistPending = (): void => pendingStore.persist()
const restorePending = (): void => pendingStore.restore()

// ---------- 给 agent 的响应 ----------

type ImageMode = 'auto' | 'always' | 'never'

// ---------- 每个版本的节点对照表 ----------
// agent 拿到的每一份画板描述，都记下当时"编号 → 元素"的对照和每个元素的指纹。
// agent 之后带着 base_version 来画时，用它把旧编号换算成现在的元素，并判断它要改的东西有没有被别人动过。
// 只放在内存里：应用重启后查不到旧版本，agent 会被要求重新读一次。

type VersionedElement = FingerprintElement

function remember(boardId: string, ver: number, elements: readonly VersionedElement[], graph: ReturnType<typeof buildGraph>): void {
  const history = getSession(boardId).history
  history.delete(ver)
  const items = [
    ...graph.nodes.map(({ id, ref, label }) => ({ id, ref, label })),
    ...graph.notes.map(({ id, ref, text }) => ({ id, ref, label: text })),
    ...graph.strokeGroups.filter((g) => g.refs.length > 0).map((g) => ({ id: g.id, ref: g.refs[0], label: null })),
    ...graph.strokes.map((s) => ({ id: s.id, ref: s.ref, label: null })),
    ...graph.images.map((img) => ({ id: img.id, ref: img.ref, label: null }))
  ]
  history.set(ver, { nodes: items, fingerprints: elementFingerprints(elements) })
  while (history.size > HISTORY_LIMIT) history.delete(history.keys().next().value as number)
}

function describe(
  sceneJson: string,
  ver: number,
  opts: { format: string; image: ImageMode },
  png: string | null,
  boardId = currentBoardId,
  viewer: string | null = null
) {
  const scene = JSON.parse(sceneJson) as { elements?: VersionedElement[]; files?: Record<string, SceneFile> }
  const graph = buildGraph((scene.elements ?? []) as SceneElement[], scene.files ?? null)
  remember(boardId, ver, (scene.elements ?? []) as VersionedElement[], graph)
  let summary = summarize(graph, { board: boardId, version: ver, viewer })
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
  const parsed = validateBoardId(rawBoard)
  const targetId = (await resolveExistingBoardId(parsed)) ?? parsed
  if (targetId === currentBoardId) return currentBoardId
  if (!win || win.isDestroyed()) bringToFront()
  await windowReady
  await switchBoard(targetId, { requireExisting: true, updateRenderer: true })
  return currentBoardId
}

const viewerOf = (body: Record<string, unknown>): string | null =>
  typeof body.agent === 'string' && body.agent.trim() ? body.agent.trim() : null

const actorOf = (body: Record<string, unknown>): string | null =>
  typeof body.as === 'string' && body.as.trim() ? body.as.trim() : viewerOf(body)

function resolveActor(
  boardId: string,
  body: Record<string, unknown>,
  elements: readonly SceneElement[] = []
): { agent: string | null; seat: boolean; color: string } {
  const session = getSession(boardId)
  syncBoardSeats(boardId, elements)
  const asName = typeof body.as === 'string' && body.as.trim() ? body.as.trim() : null
  const agent = asName || viewerOf(body)
  if (!agent) return { agent: null, seat: false, color: SEAT_COLORS[0] }
  let color = session.seats.get(agent)
  if (!color) {
    color = nextSeatColor(session.seats.values(), session.seats.size)
    session.seats.set(agent, color)
  }
  return { agent, seat: Boolean(asName), color }
}

// /draw 和 /propose 共用：把一批指令画到画布上。proposalId 不为空时画在提议层上。
// 要在 serialized() 里面调用。
async function drawOps(
  body: Record<string, unknown>,
  proposalId: string | null
): Promise<{ ok: boolean; result: Record<string, unknown>; sceneJson?: string; pending?: PendingChanges | null; boardId: string }> {
  const boardId = await ensureBoard(body.board)
  const session = getSession(boardId)
  // 先拿页面上的最新状态，版本号以它为准（用户刚画的几笔可能还没落盘）
  const snap = await takeSnapshot(false)
  const ver = await acceptScene(snap.sceneJson, boardId)
  const parsedSnap = JSON.parse(snap.sceneJson) as { elements?: VersionedElement[]; files?: Record<string, SceneFile> }
  const elements = (parsedSnap.elements ?? []) as VersionedElement[]
  const actor = resolveActor(boardId, body, elements)
  const viewer = actor.agent
  const graph = buildGraph(elements, parsedSnap.files ?? null)
  const current = () => describe(snap.sceneJson, ver, { format: 'summary', image: 'never' }, null, boardId, viewer)
  const fail = (status: 'invalid' | 'conflict', message: string) => ({ ok: false, boardId, result: { status, error: message, ...current() } })

  let ops = (Array.isArray(body.ops) ? body.ops : []) as DrawOp[]

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
    plan = planOps(ops, graph, newElementId, { direction: body.direction === 'down' ? 'down' : 'right', view: snap.view ?? null })
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
    const now = elementFingerprints(elements)
    const touched = plan.modifiedRefs.filter((ref) => record.fingerprints.get(ref) !== now.get(ref))
    if (touched.length) {
      const names = [
        ...new Set(
          touched.map((ref) => {
            const node = graph.nodes.find((n) => n.ref === ref)
            if (node) return `${node.id}${node.label ? ` ("${node.label}")` : ''}`
            const edge = graph.edges.find((e) => e.ref === ref)
            if (edge) return `arrow ${edge.from ?? '?'}→${edge.to ?? '?'}${edge.label ? ` ("${edge.label}")` : ''}`
            const note = graph.notes.find((n) => n.ref === ref)
            if (note) return `${note.id} ("${note.text}")`
            const sg = graph.strokeGroups.find((g) => g.refs.includes(ref))
            if (sg) return sg.id
            const st = graph.strokes.find((s) => s.ref === ref)
            if (st) return st.id
            return 'an arrow'
          })
        )
      ]
      return fail('conflict', `${names.join(', ')} ${names.length > 1 ? 'were' : 'was'} changed by someone else after version ${base}.`)
    }
  }

  let pending: PendingChanges | null = null
  if (proposalId) {
    const elById = new Map(elements.filter((el) => !el.isDeleted).map((el) => [el.id, el]))
    const box = (ref: string) => {
      const el = elById.get(ref)
      return el ? bboxOf(el) : null
    }
    const name = (refs: string[]) => {
      const first = refs[0]
      const node = graph.nodes.find((n) => n.ref === first)
      if (node) return node.label ? `节点「${node.label}」` : `节点 ${node.id}`
      const edge = graph.edges.find((e) => e.ref === first)
      if (edge) return `连线 ${edge.from ?? '?'}→${edge.to ?? '?'}`
      const note = graph.notes.find((n) => n.ref === first)
      if (note) return `文字「${note.text}」`
      const sg = graph.strokeGroups.find((g) => g.refs.includes(first))
      if (sg) return `手绘 ${sg.id}`
      const st = graph.strokes.find((s) => s.ref === first)
      if (st) return `手绘 ${st.id}`
      return '元素'
    }
    const converted = toProposalPlan(plan, { box, name }, newElementId)
    plan = converted.plan
    pending = converted.pending
  }

  const applied = await rpc<{ sceneJson: string }>(
    'applyPlan',
    { plan, proposalId, agent: actor.agent, seat: actor.seat, color: actor.color },
    14_000
  )
  const newVer = await acceptScene(applied.sceneJson, boardId)
  const after = buildGraph((JSON.parse(applied.sceneJson).elements ?? []) as SceneElement[])
  const nodeIds: Record<string, string> = {}
  for (const n of plan.nodes) {
    if (n.traced) continue // 照图还原出来的方框没有 agent 起的名字
    const node = after.nodes.find((x) => x.ref === n.elementId)
    if (node) nodeIds[n.key] = node.id
  }
  return {
    ok: true,
    boardId,
    sceneJson: applied.sceneJson,
    pending,
    result: {
      added: { nodes: plan.nodes.length, edges: plan.edges.length, texts: plan.texts.length, lines: plan.lines?.length ?? 0 },
      changed: {
        updated: plan.updates.filter((u) => !u.relayout).length + plan.textEdits.length,
        styled: plan.styles.length,
        deleted: plan.deletes.length,
        proposed: plan.markers.length
      },
      node_ids: nodeIds,
      ...describe(applied.sceneJson, newVer, { format: 'summary', image: 'never' }, null, boardId, viewer)
    }
  }
}

function touchSeat(body: Record<string, unknown>): void {
  seatRegistry.touch({
    bridgeId: typeof body.bridge_id === 'string' ? body.bridge_id : null,
    agent: typeof body.agent === 'string' ? body.agent : null,
    as: typeof body.as === 'string' ? body.as : null
  })
}

const routes = {
  '/seat': async (body: Record<string, unknown>) => {
    if (body.leave) {
      const bridgeId = typeof body.bridge_id === 'string' ? body.bridge_id : ''
      seatRegistry.leave(bridgeId)
    } else {
      touchSeat(body)
    }
    return { ok: true, seats: buildHubState(currentBoardId).onlineSeats ?? [] }
  },

  '/open': (body: Record<string, unknown>) => {
    touchSeat(body)
    return serialized(async () => {
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
    })
  },

  '/list': async (body: Record<string, unknown>) => {
    touchSeat(body)
    return {
      current: currentBoardId,
      boards: await listBoards()
    }
  },

  '/rename': (body: Record<string, unknown>) => {
    touchSeat(body)
    return serialized(async () => {
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
    })
  },

  '/delete': (body: Record<string, unknown>) => {
    touchSeat(body)
    return serialized(async () => {
      const targetBoard = typeof body.board === 'string' && body.board.trim() ? body.board : undefined
      const res = await deleteBoard(targetBoard, { updateRenderer: true })
      return {
        deleted: res.deleted,
        current: res.board,
        title: res.title,
        version: res.version
      }
    })
  },

  '/read': (body: Record<string, unknown>) => {
    touchSeat(body)
    return serialized(async () => {
      const image = imageMode(body.image)
      const viewer = actorOf(body)
      if (!win || win.isDestroyed()) {
        bringToFront()
      }
      const boardId =
        typeof body.board === 'string' && body.board.trim()
          ? await ensureBoard(body.board)
          : currentBoardId
      // 先不要图，算完语义发现需要时再要，省一次导出；全程处于 serialized() 内避免并发切画板串写
      let snap = await takeSnapshot(image === 'always')
      const ver = await acceptScene(snap.sceneJson, boardId)
      let res = describe(snap.sceneJson, ver, { format: String(body.format ?? 'summary'), image }, snap.pngBase64, boardId, viewer)
      if (image === 'auto' && res.needs_image && !snap.pngBase64) {
        snap = await takeSnapshot(true)
        res = describe(snap.sceneJson, ver, { format: String(body.format ?? 'summary'), image }, snap.pngBase64, boardId, viewer)
      }
      const hub = getSession(boardId).hub
      // 用户之前点过"发给 agent"但还没人来取的，这次读取就算取走了：把附言带上
      const sent = hub.takeInbox(viewer).map((s) => ({ note: s.note, at: s.at }))
      // 其他席位递过来的画笔一并交给这个席位
      const handoffs = hub.takeHandoffs(viewer).map((h) => ({ from: h.from, to: h.to, note: h.note, at: h.at }))
      return { ...res, sent, handoffs }
    })
  },

  '/draw': (body: Record<string, unknown>) => {
    touchSeat(body)
    return serialized(async () => {
      if (!win || win.isMinimized()) bringToFront()
      const res = await drawOps(body, null)
      return res.ok ? { status: 'drawn', ...res.result } : res.result
    })
  },

  // 画在提议层上，并弹出横幅请用户确认。结果用 /wait 等。
  '/propose': (body: Record<string, unknown>) => {
    touchSeat(body)
    return serialized(async () => {
      const question = String(body.question ?? '').trim()
      if (!question) throw new Error('question is required')
      const proposalId = `prop_${randomBytes(6).toString('hex')}`
      const res = await drawOps(body, proposalId)
      if (!res.ok) return res.result
      // 画成功了才弹横幅，不然用户会看到一个没有内容的确认请求
      // 记下提议刚画上去的样子，用户表态时拿来比出改了哪里
      const baseline = captureBaseline((JSON.parse(res.sceneJson ?? '{}').elements ?? []) as DiffElement[], proposalId)
      const req = getSession(res.boardId).hub.create(question, proposalId, baseline, res.pending ?? null)
      requestBoard.set(req.id, res.boardId)
      bringToFront()
      return { status: 'proposed', request_id: req.id, ...res.result }
    })
  },

  '/request': (body: Record<string, unknown>) => {
    touchSeat(body)
    return serialized(async () => {
      const prompt = String(body.prompt ?? '').trim()
      if (!prompt) throw new Error('prompt is required')
      const boardId = await ensureBoard(body.board)
      const req = getSession(boardId).hub.create(prompt)
      requestBoard.set(req.id, boardId)
      bringToFront()
      return { request_id: req.id, board: boardId, status: 'waiting' }
    })
  },

  '/pass': (body: Record<string, unknown>) => {
    touchSeat(body)
    return serialized(async () => {
      const note = String(body.note ?? '').trim()
      if (!note) throw new Error('note is required')
      if (!win || win.isMinimized()) bringToFront()
      const boardId = await ensureBoard(body.board)
      const snap = await takeSnapshot(true)
      const ver = await acceptScene(snap.sceneJson, boardId)
      const elements = (JSON.parse(snap.sceneJson).elements ?? []) as SceneElement[]
      const actor = resolveActor(boardId, body, elements)
      const from = actor.agent || 'agent'
      const to = typeof body.to === 'string' && body.to.trim() ? body.to.trim() : null
      if (to && to === from) throw new Error('cannot pass the brush to the same seat')
      const delivered = getSession(boardId).hub.passBaton({
        from,
        to,
        note,
        sceneJson: snap.sceneJson,
        pngBase64: snap.pngBase64,
        version: ver,
        at: new Date().toISOString()
      })
      return { status: delivered ? 'delivered' : 'queued', from, to, board: boardId, version: ver }
    })
  },

  '/wait': async (body: Record<string, unknown>) => {
    touchSeat(body)
    const seconds = Math.min(Math.max(Number(body.timeout_s) || WAIT_DEFAULT_S, 1), WAIT_MAX_S)
    const requestId = typeof body.request_id === 'string' && body.request_id ? body.request_id : null
    const viewer = actorOf(body)
    const boardId = requestId
      ? (requestBoard.get(requestId) ?? currentBoardId)
      : typeof body.board === 'string' && body.board.trim()
        ? ((await resolveExistingBoardId(validateBoardId(body.board))) ?? validateBoardId(body.board))
        : currentBoardId
    const result: WaitResult = await getSession(boardId).hub.wait(requestId ? { requestId } : { inbox: true, agent: viewer }, seconds * 1000)
    touchSeat(body)
    if (result.status === 'handoff') {
      const h = result.handoff
      return {
        status: 'handoff',
        from: h.from,
        to: h.to,
        note: h.note,
        submitted_at: h.at,
        ...describe(h.sceneJson, h.version, { format: String(body.format ?? 'summary'), image: imageMode(body.image) }, h.pngBase64, boardId, viewer)
      }
    }
    // 请求已经被清掉了（或从来不存在）：它属于哪块画板的记录也不用留
    if (result.status === 'unknown_request' && requestId) requestBoard.delete(requestId)
    if (result.status !== 'submitted') return { ...result, request_id: requestId }
    const sub = result.submission
    return {
      status: 'submitted',
      request_id: sub.requestId,
      decision: sub.decision ?? null,
      changes: sub.changes ?? null,
      note: sub.note,
      submitted_at: sub.at,
      ...describe(sub.sceneJson, sub.version, { format: String(body.format ?? 'summary'), image: imageMode(body.image) }, sub.pngBase64, boardId, viewer)
    }
  }
}

// ---------- 页面发来的调用 ----------

ipcMain.handle('board:load', async () => {
  const loaded = await loadBoard(currentBoardId)
  return { ...loaded, boards: await listBoards() }
})
ipcMain.handle('board:list', async () => ({ current: currentBoardId, boards: await listBoards() }))
// 页面带上这份内容属于哪块画板：自动保存是延时触发的，可能在 agent 切换、重命名或删除画板之后才到，
// 只按「当前画板」存的话，上一块画板的内容会盖到新切过去的画板上。
ipcMain.handle('board:save', (_e, json: unknown, board?: unknown) =>
  serialized(async () => {
    if (typeof json !== 'string') throw new Error('board:save expects a JSON string')
    const rawBoard = typeof board === 'string' && isValidBoardId(board) ? board : currentBoardId
    const boardId = (await resolveExistingBoardId(rawBoard)) ?? rawBoard
    const path = boardFilePath(BOARDS_DIR, boardId)
    if (boardId !== currentBoardId && !existsSync(path)) {
      // 那块画板已经被改名或删除：不存，让页面自己决定要不要按新名字重存
      return { board: boardId, path, saveCount, version: 0, savedAt: new Date().toISOString(), skipped: true }
    }
    const ver = await acceptScene(json, boardId)
    return { board: boardId, path, saveCount, version: ver, savedAt: new Date().toISOString(), skipped: false }
  })
)
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
ipcMain.handle('hub:state', () => buildHubState(currentBoardId))
ipcMain.handle('dock:state', (): DockState => dock?.state() ?? { docked: false, side: null, title: null })
ipcMain.on('dock:release', () => dock?.release())
type SubmitPayload = {
  board?: string
  requestId: string | null
  note: string
  sceneJson: string
  pngBase64: string | null
  decision?: 'accepted' | 'rejected' | null
  skipped?: string[]
  to?: string | null // 主动发送时点选的目标席位
}
// 隔离的测试实例（TEST_INSTANCE）不碰系统剪贴板，免得跑测试时冲掉用户正在用的内容
ipcMain.handle('hub:submit', (_e, payload: SubmitPayload) =>
  serialized(async () => {
    const requestedBoard =
      payload.requestId && requestBoard.has(payload.requestId)
        ? requestBoard.get(payload.requestId)!
        : typeof payload.board === 'string' && isValidBoardId(payload.board)
          ? ((await resolveExistingBoardId(payload.board)) ?? payload.board)
          : currentBoardId
    const targetPath = boardFilePath(BOARDS_DIR, requestedBoard)
    if (requestedBoard !== currentBoardId && !existsSync(targetPath)) {
      throw new Error('该画板已被删除或重命名，请重新确认后再发送')
    }
    const boardId = requestedBoard
    const hub = getSession(boardId).hub
    const ver = await acceptScene(payload.sceneJson, boardId)
    const decision = payload.decision === 'accepted' || payload.decision === 'rejected' ? payload.decision : null
    // 回应提议时，比出用户在提议上改了什么。拒绝时提议已经被删掉，只看用户自己加了什么没有意义，不比。
    const req = payload.requestId ? hub.get(payload.requestId) : undefined
    let changes: string[] | null = null
    if (decision === 'accepted' && req?.kind === 'proposal') {
      const diff = req.baseline ? diffProposal(req.baseline as ProposalBaseline, (JSON.parse(payload.sceneJson).elements ?? []) as DiffElement[]) : []
      const skipped = Array.isArray(payload.skipped) ? payload.skipped.filter((s): s is string => typeof s === 'string' && Boolean(s)) : []
      changes = [...skipped, ...diff]
    }
    const sub: Submission = {
      requestId: payload.requestId,
      decision,
      changes,
      note: String(payload.note ?? '').trim(),
      sceneJson: payload.sceneJson,
      pngBase64: payload.pngBase64,
      version: ver,
      at: new Date().toISOString(),
      to: !payload.requestId && typeof payload.to === 'string' && payload.to.trim() ? payload.to.trim() : null
    }
    const delivered = hub.submit(sub)
    // 没有 agent 接到：把一句取画的话放进剪贴板，用户粘贴到那个 agent 的聊天里它就会来取
    let hint: string | null = null
    if (!delivered) {
      hint = pickupHint({ board: boardId, title: getSession(boardId).title, version: ver, to: sub.to })
      if (!TEST_INSTANCE) clipboard.writeText(hint)
    }
    return { version: ver, delivered, hint }
  })
)
// 收件箱里还有没被取走的画时，用户可以再要一次那句取画的话（比如剪贴板已经被别的内容盖掉了）
ipcMain.handle('hub:hint', () => {
  const boardId = currentBoardId
  const session = getSession(boardId)
  const queued = session.hub.queuedInbox()
  const last = queued[queued.length - 1]
  if (!last) return null
  const hint = pickupHint({ board: boardId, title: session.title, version: last.version, to: last.to })
  if (!TEST_INSTANCE) clipboard.writeText(hint)
  return hint
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

  const daemon = createDaemonLifecycle()

  app.whenReady().then(async () => {
    if (daemon.isQuitting()) return
    restorePending()
    createWindow()
    createTray()
    await daemon.start(() => startDaemon(daemonInfoPath, routes))
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    // 常驻时窗口只是藏起来；万一页面进程崩了窗口没了，托盘还在，点它会重新打开
    if (process.platform !== 'darwin' && (quitting || !tray)) app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    daemon.markQuitting()
  })

  let engineClosing = false
  let engineClosed = false
  app.on('before-quit', (event) => {
    if (engineClosed) return
    event.preventDefault()
    if (engineClosing) return
    engineClosing = true
    void agent.close().catch(error => console.error('[flyingdraws] agent shutdown failed:', error)).finally(() => {
      engineClosed = true
      app.quit()
    })
  })

  app.on('will-quit', (event) => {
    const closing = daemon.closeOnQuit()
    if (!closing) return
    event.preventDefault()
    void closing.finally(() => app.quit())
  })
}
