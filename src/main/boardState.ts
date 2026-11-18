// 多画板会话状态、画板读写、切换/重命名/删除，以及待确认请求的存盘恢复。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { SceneElement } from './semantic'
import { RequestHub, type HubState } from './requests'
import { PendingStore } from './pending'
import { nextSeatColor, SeatRegistry } from './seats'
import { atomicWriteJson } from './atomicWrite'
import { BOARD_EXT, DEFAULT_BOARD_ID, boardFilePath, emptyBoardScene, isValidBoardId, matchExistingBoardId, normalizeBoardId, normalizeBoardTitle, parseBoardMeta, pickFallbackBoard, sameBoardOnDisk, updateBoardSceneTitle, validateBoardId, type BoardMeta } from './boards'
import { HOME, BOARDS_DIR, legacyM0Path, pendingPath, statePath } from './paths'
import { win, agent, currentBoardId, setCurrentBoardId } from './context'
import { rpc, takeSnapshot } from './rpc'

export interface VersionRecord {
  nodes: { id: string; ref: string; refs?: string[]; label: string | null }[]
  fingerprints: Map<string, string> // 元素 id → 指纹
}
export const HISTORY_LIMIT = 60

export interface BoardSession {
  id: string
  title: string | null
  version: number
  lastElementsKey: string | null
  hub: RequestHub
  history: Map<number, VersionRecord>
  seats: Map<string, string>
  drawnAgents: Set<string>
}

export interface BoardInfo extends BoardMeta {
  active: boolean
}

export const sessions = new Map<string, BoardSession>()
export const seatRegistry = new SeatRegistry()
export const requestBoard = new Map<string, string>() // request_id → boardId
export let saveCount = 0

export function persistCurrentBoard(): void {
  try {
    mkdirSync(HOME, { recursive: true })
    writeFileSync(statePath, JSON.stringify({ currentBoard: currentBoardId }), 'utf8')
  } catch (err) {
    console.error('[flyingdraws] could not save active board:', err)
  }
}

export function getSession(id: string): BoardSession {
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

export function syncBoardSeats(boardId: string, elements: readonly SceneElement[]): void {
  const session = getSession(boardId)
  const drawn = new Set<string>()
  for (const el of elements) {
    if (el.isDeleted) continue
    const mark = el.customData?.flyingdraws
    if (mark?.role === 'marker' || mark?.role === 'move-ghost' || mark?.author !== 'agent') continue
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

export const allWaitingAgents = (): string[] => [...sessions.values()].flatMap((s) => s.hub.state().waitingAgents)

export function buildHubState(boardId = currentBoardId): HubState {
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

export function updateWindowTitle(): void {
  if (!win || win.isDestroyed()) return
  const s = getSession(currentBoardId)
  win.setTitle(s.title ? `Flying draws — ${s.title} (${s.id})` : `Flying draws — ${s.id}`)
}

// ---------- 画板读写与版本号 ----------

// 对元素序列的 (id, version, versionNonce, isDeleted) 做有序摘要，防止等和换元素撞键漏升版本号
export function elementsKey(elements: { id?: string; version?: number; versionNonce?: number; isDeleted?: boolean }[]): string {
  const hash = createHash('sha1')
  hash.update(`${elements.length}:`)
  for (const el of elements) {
    hash.update(`${el.id ?? ''}\0${el.version ?? 0}\0${el.versionNonce ?? ''}\0${el.isDeleted ? 1 : 0}\n`)
  }
  return hash.digest('hex')
}

export async function loadBoard(id = currentBoardId): Promise<{ board: string; title: string | null; version: number; json: string | null; path: string }> {
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
export async function acceptScene(json: string, id = currentBoardId): Promise<number> {
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

export async function listDiskBoardIds(): Promise<string[]> {
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

export async function resolveExistingBoardId(id: string): Promise<string | null> {
  const diskIds = await listDiskBoardIds()
  const candidates = diskIds.some((x) => sameBoardOnDisk(x, currentBoardId)) ? diskIds : [...diskIds, currentBoardId]
  return matchExistingBoardId(id, candidates)
}

export async function listBoards(): Promise<BoardInfo[]> {
  const items: BoardInfo[] = []
  const diskIds = await listDiskBoardIds()
  const seen = new Set<string>()
  for (const id of diskIds) {
    seen.add(id)
    const active = sameBoardOnDisk(id, currentBoardId)
    if (active && id !== currentBoardId) setCurrentBoardId(id)
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

export async function flushOutgoingScene(
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

export async function switchBoard(
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

  setCurrentBoardId(targetId)
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

export async function renameBoard(
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
    setCurrentBoardId(toId)
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

export async function deleteBoard(
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
    setCurrentBoardId(nextId)
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

export function pushHubState(): void {
  if (win && !win.isDestroyed()) win.webContents.send('hub:state', buildHubState(currentBoardId))
}

// ---------- 还在等用户回应的请求与未取走的收件箱：存盘，重启后恢复 ----------
// 不存的话，应用重启后横幅没了，提议层上的元素却还留在画布上，没有按钮可以确认；
// 用户主动"发给 agent"的画如果还在收件箱里，重启也会丢失。

export const pendingStore = new PendingStore({
  pendingPath,
  boardsDir: BOARDS_DIR,
  getCurrentBoardId: () => currentBoardId,
  sessions,
  getHub: (boardId) => getSession(boardId).hub,
  onRequestRestored: (requestId, boardId) => requestBoard.set(requestId, boardId)
})

export const persistPending = (): void => pendingStore.persist()
export const restorePending = (): void => pendingStore.restore()
