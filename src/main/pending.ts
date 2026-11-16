// 等待用户回应的请求、收件箱和递画笔交接的持久化与启动恢复（不依赖 Electron，可独立测试）
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_BOARD_ID, boardFilePath, isValidBoardId } from './boards.ts'
import type { DiffElement } from './diff.ts'
import type { DrawRequest, Handoff, RequestHub, Submission } from './requests.ts'

export interface PendingIo {
  existsSync: typeof existsSync
  mkdirSync: typeof mkdirSync
  readFileSync: typeof readFileSync
  writeFileSync: typeof writeFileSync
  renameSync: typeof renameSync
}

export interface PendingStoreDeps {
  pendingPath: string
  boardsDir: string
  getCurrentBoardId: () => string
  sessions: ReadonlyMap<string, { hub: RequestHub }>
  getHub: (boardId: string) => RequestHub
  onRequestRestored?: (requestId: string, boardId: string) => void
  io?: Partial<PendingIo>
}

export function pendingStateKey(
  boards: Record<string, DrawRequest[]>,
  inbox: Record<string, Submission[]>,
  handoffs: Record<string, Handoff[]>
): string {
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
  const handoffKey = Object.entries(handoffs)
    .filter(([, list]) => list.length > 0)
    .map(([id, list]) => `${id}:${list.map((h) => `${h.at}:${h.from}:${h.to ?? ''}`).join(',')}`)
    .sort()
    .join('|')
  return `${reqKey}#${inboxKey}#${handoffKey}`
}

/**
 * 管理 pending.json 的原子落盘与启动恢复。
 * restore() 期间抑制 hub.onChange 触发的中途落盘，避免多画板恢复到一半时覆盖掉尚未恢复的画板；
 * persist() 仅在原子 renameSync 成功后更新 lastPendingKey，保证磁盘写入失败后可重试。
 */
export class PendingStore {
  private readonly deps: PendingStoreDeps
  private readonly fs: PendingIo
  private lastPendingKey = '#'
  private restoring = false

  constructor(deps: PendingStoreDeps) {
    this.deps = deps
    this.fs = {
      existsSync: deps.io?.existsSync ?? existsSync,
      mkdirSync: deps.io?.mkdirSync ?? mkdirSync,
      readFileSync: deps.io?.readFileSync ?? readFileSync,
      writeFileSync: deps.io?.writeFileSync ?? writeFileSync,
      renameSync: deps.io?.renameSync ?? renameSync
    }
  }

  persist(): void {
    if (this.restoring) return
    const boards: Record<string, DrawRequest[]> = {}
    const inbox: Record<string, Submission[]> = {}
    const handoffs: Record<string, Handoff[]> = {}
    for (const [id, session] of this.deps.sessions) {
      const waiting = session.hub.waiting()
      if (waiting.length) boards[id] = waiting
      const queued = session.hub.queuedInbox()
      if (queued.length) inbox[id] = queued
      const queuedPasses = session.hub.queuedHandoffs()
      if (queuedPasses.length) handoffs[id] = queuedPasses
    }
    const key = pendingStateKey(boards, inbox, handoffs)
    if (key === this.lastPendingKey) return // 只是有 agent 开始或结束等待，请求和收件箱本身没变
    try {
      this.fs.mkdirSync(dirname(this.deps.pendingPath), { recursive: true })
      const tmp = `${this.deps.pendingPath}.tmp`
      const payload = {
        version: 2,
        boards,
        ...(Object.keys(inbox).length ? { inbox } : {}),
        ...(Object.keys(handoffs).length ? { handoffs } : {})
      }
      // 同步原子写盘，保证应用被强杀前已落盘且不留半截文件
      this.fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      this.fs.renameSync(tmp, this.deps.pendingPath)
      this.lastPendingKey = key
    } catch (err) {
      console.error('[flyingdraws] could not save pending requests:', err)
    }
  }

  restore(): void {
    let perBoard: Record<string, DrawRequest[]> = {}
    let perInbox: Record<string, Submission[]> = {}
    let perHandoffs: Record<string, Handoff[]> = {}
    try {
      const raw = JSON.parse(this.fs.readFileSync(this.deps.pendingPath, 'utf8')) as {
        version?: number
        board?: string
        requests?: DrawRequest[]
        boards?: Record<string, DrawRequest[]>
        inbox?: Record<string, Submission[]>
        handoffs?: Record<string, Handoff[]>
      }
      if (raw.version === 2) {
        if (raw.boards && typeof raw.boards === 'object') perBoard = raw.boards
        if (raw.inbox && typeof raw.inbox === 'object') perInbox = raw.inbox
        if (raw.handoffs && typeof raw.handoffs === 'object') perHandoffs = raw.handoffs
      } else if (Array.isArray(raw.requests)) {
        perBoard = { [raw.board && isValidBoardId(raw.board) ? raw.board : DEFAULT_BOARD_ID]: raw.requests }
      }
    } catch {
      return // 没有存过，或者文件坏了：当作没有待处理的请求
    }

    const currentBoardId = this.deps.getCurrentBoardId()
    const restoredBoards: Record<string, DrawRequest[]> = {}
    const restoredInbox: Record<string, Submission[]> = {}
    const restoredHandoffs: Record<string, Handoff[]> = {}
    const allBoardIds = new Set([...Object.keys(perBoard), ...Object.keys(perInbox), ...Object.keys(perHandoffs)])

    this.restoring = true
    try {
      for (const boardId of allBoardIds) {
        if (!isValidBoardId(boardId)) continue
        const boardPath = boardFilePath(this.deps.boardsDir, boardId)
        const boardExists = this.fs.existsSync(boardPath)
        if (!boardExists && boardId !== currentBoardId) continue
        const saved = Array.isArray(perBoard[boardId]) ? perBoard[boardId] : []
        const savedInbox = Array.isArray(perInbox[boardId]) ? perInbox[boardId] : []
        const savedHandoffs = Array.isArray(perHandoffs[boardId]) ? perHandoffs[boardId] : []
        // 提议对应的元素要是已经不在画板上了（比如用户手动删光了），这个提议就不用再问；
        // 画板文件存在但读/解析失败时保持 null，避免把还能恢复的 proposal 请求误删。
        let proposalsOnBoard: Set<string> | null = boardExists ? null : new Set()
        if (boardExists) {
          try {
            const parsed = JSON.parse(this.fs.readFileSync(boardPath, 'utf8')) as { elements?: unknown }
            if (parsed && typeof parsed === 'object' && Array.isArray(parsed.elements)) {
              const elements = parsed.elements as DiffElement[]
              proposalsOnBoard = new Set(
                elements
                  .filter((el) => !el.isDeleted && el.customData?.flyingdraws?.layer === 'proposal')
                  .map((el) => String(el.customData?.flyingdraws?.proposal))
              )
            }
          } catch {}
        }
        const usable = saved.filter(
          (r) =>
            r &&
            typeof r.id === 'string' &&
            (r.kind !== 'proposal' ||
              (typeof r.proposalId === 'string' && r.proposalId && (proposalsOnBoard === null || proposalsOnBoard.has(r.proposalId))))
        )
        const usableInbox = savedInbox.filter((s) => s && typeof s.sceneJson === 'string' && typeof s.at === 'string')
        const usableHandoffs = savedHandoffs.filter(
          (h) => h && typeof h.from === 'string' && typeof h.sceneJson === 'string' && typeof h.at === 'string'
        )
        if (!usable.length && !usableInbox.length && !usableHandoffs.length) continue
        if (usable.length) restoredBoards[boardId] = usable
        if (usableInbox.length) restoredInbox[boardId] = usableInbox
        if (usableHandoffs.length) restoredHandoffs[boardId] = usableHandoffs
        for (const r of usable) this.deps.onRequestRestored?.(r.id, boardId)
        this.deps.getHub(boardId).restore(usable, usableInbox, usableHandoffs)
      }
      this.lastPendingKey = pendingStateKey(restoredBoards, restoredInbox, restoredHandoffs)
    } finally {
      this.restoring = false
    }
  }
}
