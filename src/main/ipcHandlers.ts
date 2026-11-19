// 页面发来的调用。导入本模块即注册全部 handler。
import { clipboard, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { pickupHint, type Submission } from './requests'
import { diffProposal, type DiffElement, type ProposalBaseline } from './diff'
import type { DockState } from './dock'
import { boardFilePath, isValidBoardId } from './boards'
import { BOARDS_DIR, libraryStore, TEST_INSTANCE } from './paths'
import { ipc, currentBoardId, savedTheme } from './context'
import { requestBoard, saveCount, getSession, buildHubState, loadBoard, acceptScene, resolveExistingBoardId, listBoards, switchBoard, renameBoard, deleteBoard } from './boardState'
import { dock } from './window'
import { serialized } from './draw'

ipc.handle('board:load', async () => {
  const loaded = await loadBoard(currentBoardId)
  return { ...loaded, boards: await listBoards(), theme: savedTheme }
})
ipc.handle('board:list', async () => ({ current: currentBoardId, boards: await listBoards() }))
// 页面带上这份内容属于哪块画板：自动保存是延时触发的，可能在 agent 切换、重命名或删除画板之后才到，
// 只按「当前画板」存的话，上一块画板的内容会盖到新切过去的画板上。
ipc.handle('board:save', (_e, json: unknown, board?: unknown) =>
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
ipc.handle('board:create', (_e, payload: { name: string; title?: string; currentSceneJson?: string }) =>
  serialized(() =>
    switchBoard(payload.name, {
      title: payload.title,
      createOnly: true,
      outgoingSceneJson: payload.currentSceneJson
    })
  )
)
ipc.handle('board:switch', (_e, payload: { board: string; currentSceneJson?: string }) =>
  serialized(() =>
    switchBoard(payload.board, {
      requireExisting: true,
      outgoingSceneJson: payload.currentSceneJson
    })
  )
)
ipc.handle('board:rename', (_e, payload: { board?: string; name: string; title?: string | null; currentSceneJson?: string }) =>
  serialized(() =>
    renameBoard(payload.board, payload.name, {
      title: payload.title,
      outgoingSceneJson: payload.currentSceneJson
    })
  )
)
ipc.handle('board:delete', (_e, payload: { board: string; currentSceneJson?: string }) =>
  serialized(() =>
    deleteBoard(payload.board, {
      outgoingSceneJson: payload.currentSceneJson
    })
  )
)
ipc.handle('board:reveal', () => {
  const p = boardFilePath(BOARDS_DIR, currentBoardId)
  if (existsSync(p)) return shell.showItemInFolder(p)
  mkdirSync(BOARDS_DIR, { recursive: true })
  return shell.openPath(BOARDS_DIR)
})
ipc.handle('hub:state', () => buildHubState(currentBoardId))
ipc.handle('dock:state', (): DockState => dock?.state() ?? { docked: false, side: null, title: null })
ipc.on('dock:release', () => dock?.release())
export type SubmitPayload = {
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
ipc.handle('hub:submit', (_e, payload: SubmitPayload) =>
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
ipc.handle('hub:hint', () => {
  const boardId = currentBoardId
  const session = getSession(boardId)
  const queued = session.hub.queuedInbox()
  const last = queued[queued.length - 1]
  if (!last) return null
  const hint = pickupHint({ board: boardId, title: session.title, version: last.version, to: last.to })
  if (!TEST_INSTANCE) clipboard.writeText(hint)
  return hint
})
ipc.handle('hub:cancel', (_e, requestId: string) => {
  const boardId = requestBoard.get(requestId) ?? currentBoardId
  return getSession(boardId).hub.cancel(requestId)
})
ipc.handle('library:load', () => libraryStore.load())
ipc.handle('library:save', (_e, data: { libraryItems?: unknown[] }) =>
  libraryStore.save({ libraryItems: Array.isArray(data?.libraryItems) ? data.libraryItems : [] })
)
