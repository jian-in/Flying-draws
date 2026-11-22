// 本地 HTTP 守护进程的路由，给 MCP 桥和外部 agent 调用。
import { randomBytes } from 'node:crypto'
import type { SceneElement } from './semantic'
import type { WaitResult } from './requests'
import { captureBaseline, type DiffElement } from './diff'
import { validateBoardId } from './boards'
import { WAIT_MAX_S, WAIT_DEFAULT_S, HOME } from './paths'
import { win, agent, currentBoardId, windowReady } from './context'
import { takeSnapshot } from './rpc'
import { seatRegistry, requestBoard, getSession, buildHubState, acceptScene, resolveExistingBoardId, listBoards, switchBoard, renameBoard, deleteBoard } from './boardState'
import { bringToFront } from './window'
import { describe, imageMode, serialized, ensureBoard, actorOf, resolveActor, drawOps, touchSeat } from './draw'

export const routes = {
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
      let ver = await acceptScene(snap.sceneJson, boardId)
      let res = describe(snap.sceneJson, ver, { format: String(body.format ?? 'summary'), image }, snap.pngBase64, boardId, viewer)
      if (image === 'auto' && res.needs_image && !snap.pngBase64) {
        snap = await takeSnapshot(true)
        ver = await acceptScene(snap.sceneJson, boardId)
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
      if (!win || win.isDestroyed() || win.isMinimized()) bringToFront()
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

  '/wait': async (body: Record<string, unknown>, ctx?: { signal: AbortSignal }) => {
    touchSeat(body)
    const seconds = Math.min(Math.max(Number(body.timeout_s) || WAIT_DEFAULT_S, 1), WAIT_MAX_S)
    const requestId = typeof body.request_id === 'string' && body.request_id ? body.request_id : null
    const viewer = actorOf(body)
    let boardId = currentBoardId
    if (requestId) boardId = requestBoard.get(requestId) ?? currentBoardId
    else if (typeof body.board === 'string' && body.board.trim()) {
      const existing = await resolveExistingBoardId(validateBoardId(body.board))
      // 等一块不存在的画板永远等不到东西：直接说清楚，并带上数据目录，方便发现连错了实例（比如残留的 FLYINGDRAWS_HOME）
      if (!existing) throw new Error(`board "${body.board.trim()}" does not exist in the canvas whose data directory is ${HOME}. Check the board name with canvas_list; if that directory is unexpected, the FLYINGDRAWS_HOME environment variable may be pointing to another canvas instance.`)
      boardId = existing
    }
    const session = getSession(boardId)
    const result: WaitResult = await session.hub.wait(requestId ? { requestId } : { inbox: true, agent: viewer }, seconds * 1000, ctx?.signal)
    touchSeat(body)
    if (result.status === 'handoff') {
      const h = result.handoff
      return {
        status: 'handoff',
        from: h.from,
        to: h.to,
        note: h.note,
        submitted_at: h.at,
        ...describe(h.sceneJson, h.version, { format: String(body.format ?? 'summary'), image: imageMode(body.image) }, h.pngBase64, session.id, viewer)
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
      ...describe(sub.sceneJson, sub.version, { format: String(body.format ?? 'summary'), image: imageMode(body.image) }, sub.pngBase64, session.id, viewer)
    }
  }
}
