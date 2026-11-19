// /draw 和 /propose 的执行管线：版本对照表、画板描述、写入队列、指令落到画布。
import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { bboxOf, buildGraph, summarize, type SceneElement, type SceneFile } from './semantic'
import { OpsError, elementFingerprints, planOps, rebaseOps, toProposalPlan, type DrawOp, type DrawPlan, type FingerprintElement, type PendingChanges } from './ops'
import { SEAT_COLORS, nextSeatColor } from './seats'
import { validateBoardId } from './boards'
import { win, agent, currentBoardId, windowReady } from './context'
import { rpc, takeSnapshot } from './rpc'
import { HISTORY_LIMIT, seatRegistry, getSession, syncBoardSeats, acceptScene, resolveExistingBoardId, switchBoard } from './boardState'
import { bringToFront } from './window'

// ---------- 给 agent 的响应 ----------

export type ImageMode = 'auto' | 'always' | 'never'

// ---------- 每个版本的节点对照表 ----------
// agent 拿到的每一份画板描述，都记下当时"编号 → 元素"的对照和每个元素的指纹。
// agent 之后带着 base_version 来画时，用它把旧编号换算成现在的元素，并判断它要改的东西有没有被别人动过。
// 只放在内存里：应用重启后查不到旧版本，agent 会被要求重新读一次。

export type VersionedElement = FingerprintElement

export function remember(boardId: string, ver: number, elements: readonly VersionedElement[], graph: ReturnType<typeof buildGraph>): void {
  const history = getSession(boardId).history
  history.delete(ver)
  const items = [
    ...graph.nodes.map(({ id, ref, label }) => ({ id, ref, label })),
    ...graph.notes.map(({ id, ref, text }) => ({ id, ref, label: text })),
    ...graph.strokeGroups.filter((g) => g.refs.length > 0).map((g) => ({ id: g.id, ref: g.refs[0], refs: [...g.refs], label: null })),
    ...graph.strokes.map((s) => ({ id: s.id, ref: s.ref, label: null })),
    ...graph.images.map((img) => ({ id: img.id, ref: img.ref, label: null }))
  ]
  history.set(ver, { nodes: items, fingerprints: elementFingerprints(elements) })
  while (history.size > HISTORY_LIMIT) history.delete(history.keys().next().value as number)
}

export function describe(
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

export function imageMode(v: unknown): ImageMode {
  return v === 'always' || v === 'never' ? v : 'auto'
}

// 所有写入排成一队，一次只执行一批，避免两批指令基于同一个旧版本互相覆盖
export let writeChain: Promise<unknown> = Promise.resolve()
export function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn)
  writeChain = run.catch(() => undefined)
  return run
}

export const newElementId = (): string => `sl_${randomBytes(8).toString('hex')}`

// 请求指定了 board 且不是当前画板时，先切换过去（要求已存在）
export async function ensureBoard(rawBoard: unknown): Promise<string> {
  if (typeof rawBoard !== 'string' || !rawBoard.trim()) return currentBoardId
  const parsed = validateBoardId(rawBoard)
  const targetId = (await resolveExistingBoardId(parsed)) ?? parsed
  if (targetId === currentBoardId) return currentBoardId
  if (!win || win.isDestroyed()) bringToFront()
  await windowReady
  await switchBoard(targetId, { requireExisting: true, updateRenderer: true })
  return currentBoardId
}

export const viewerOf = (body: Record<string, unknown>): string | null =>
  typeof body.agent === 'string' && body.agent.trim() ? body.agent.trim() : null

export const actorOf = (body: Record<string, unknown>): string | null =>
  typeof body.as === 'string' && body.as.trim() ? body.as.trim() : viewerOf(body)

export function resolveActor(
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
export async function drawOps(
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
  const MOVE_ALLOWED_KEYS = new Set(['op', 'id', 'x', 'y', 'dx', 'dy', 'near', 'side', 'gap'])
  for (let i = 0; i < ops.length; i++) {
    const rawOp = ops[i] as unknown as Record<string, unknown> | null
    if (rawOp && typeof rawOp === 'object' && rawOp.op === 'move') {
      const unknown = Object.keys(rawOp).filter((k) => !MOVE_ALLOWED_KEYS.has(k))
      if (unknown.length) return fail('invalid', `ops[${i}]: unknown field(s) on move: ${unknown.join(', ')}`)
    }
  }

  // agent 是基于哪个版本下的指令。和当前版本不一样时，先把指令里的旧编号换算成现在的。
  const rawBase = body.base_version
  if (rawBase !== undefined && rawBase !== null) {
    if (typeof rawBase !== 'number' || !Number.isInteger(rawBase) || rawBase < 0) {
      return fail('invalid', 'base_version must be a non-negative integer')
    }
  }
  const base = typeof rawBase === 'number' ? rawBase : NaN
  const record = Number.isFinite(base) && base !== ver ? session.history.get(base) : undefined
  const nameAt = (id: string) => {
    const trimmed = id.trim()
    const label = record?.nodes.find((n) => n.id === trimmed)?.label
    return label ? `${trimmed} ("${label}")` : trimmed
  }
  if (record) {
    const rebased = rebaseOps(ops, record.nodes, graph)
    if (rebased.gone.length) {
      const verb = rebased.gone.length > 1 ? 'were' : 'was'
      // 手绘组（S1）不一定整组被删：用户删掉其中一笔后，它也不再是读到时的那一组了
      const strokeGroupChanged = rebased.gone.some((id) => /^S\d+$/.test(id.trim()))
      return fail(
        'conflict',
        strokeGroupChanged
          ? `${rebased.gone.map(nameAt).join(', ')} ${verb} deleted or changed after version ${base} (a hand-drawn group may have lost or gained strokes). Read the canvas again and use the new ids.`
          : `${rebased.gone.map(nameAt).join(', ')} ${verb} deleted after version ${base}.`
      )
    }
    ops = rebased.ops
  }

  let plan: DrawPlan
  try {
    plan = planOps(ops, graph, newElementId, { direction: body.direction === 'down' ? 'down' : 'right', view: snap.view ?? null, elements })
  } catch (err) {
    if (err instanceof OpsError) return fail('invalid', err.message)
    throw err
  }

  const refNameEn = (ref: string): string => {
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
    const img = graph.images.find((i) => i.ref === ref)
    if (img) return img.id
    return 'an element'
  }

  // 只新增、或只用稳定 id 做只读 trace_image 的指令在任何版本上都能执行；引用了短编号或改动已有元素时必须过版本与指纹检查：
  if ((plan.existingRefs.length || plan.modifiedRefs.length) && base !== ver) {
    if (!record) {
      // 查不到 agent 读的那个版本，编号与改动基线没法核实
      return fail(
        'conflict',
        Number.isFinite(base)
          ? `The canvas has no record of version ${base} (the app may have restarted, or that read is too old), so node ids like N1 cannot be trusted.`
          : 'These ops refer to or modify elements already on the canvas, so base_version is required.'
      )
    }
    // 引用的节点只要还在就行；但要改动、移动或删除的元素，从那个版本到现在不能被别人动过
    const now = elementFingerprints(elements)
    const touched = plan.modifiedRefs.filter((ref) => record.fingerprints.get(ref) !== now.get(ref))
    if (touched.length) {
      const names = [...new Set(touched.map(refNameEn))]
      return fail('conflict', `${names.join(', ')} ${names.length > 1 ? 'were' : 'was'} changed by someone else after version ${base}.`)
    }
  }

  // 防止同一已有元素同时挂在另一个尚未表态的提议改动列表里（或被直接 draw 绕过待决提议）
  if (plan.modifiedRefs.length) {
    const lockedByPending = new Set<string>()
    for (const p of session.hub.state().pending) {
      const pc = p.pending as PendingChanges | null | undefined
      for (const m of pc?.markers ?? []) for (const t of m.targets) lockedByPending.add(t)
    }
    const overlapping = plan.modifiedRefs.filter((ref) => lockedByPending.has(ref))
    if (overlapping.length) {
      const names = [...new Set(overlapping.map(refNameEn))]
      return fail('conflict', `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} already part of an unanswered proposal on this board.`)
    }
  }

  const plannedMoves = plan.moves
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
      const img = graph.images.find((i) => i.ref === first)
      if (img) return `图片 ${img.id}`
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
  const moved = plan.moves.map((m) => {
    const node = after.nodes.find((x) => x.ref === m.targetKey)
    const note = !node ? after.notes.find((x) => x.ref === m.targetKey) : undefined
    const sg = !node && !note ? after.strokeGroups.find((x) => x.refs.includes(m.targetKey)) : undefined
    const st = !node && !note && !sg ? after.strokes.find((x) => x.ref === m.targetKey) : undefined
    const img = !node && !note && !sg && !st ? after.images.find((x) => x.ref === m.targetKey) : undefined
    const found = node ?? note ?? sg ?? st ?? img
    return {
      id: m.id,
      now_id: found?.id ?? null,
      bbox: found?.bbox ?? m.toBbox,
      ...(m.adjusted ? { adjusted: true } : {}),
      ...(m.overlaps?.length ? { overlaps: m.overlaps } : {})
    }
  })
  const proposedMoves = proposalId
    ? plannedMoves.map((m) => ({
        id: m.id,
        bbox: m.toBbox,
        ...(m.adjusted ? { adjusted: true } : {}),
        ...(m.overlaps?.length ? { overlaps: m.overlaps } : {})
      }))
    : []
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
        moved: plan.moves.length,
        deleted: plan.deletes.length,
        proposed: plan.markers.length
      },
      node_ids: nodeIds,
      ...(moved.length ? { moved } : {}),
      ...(proposedMoves.length ? { proposed_moves: proposedMoves } : {}),
      ...describe(applied.sceneJson, newVer, { format: 'summary', image: 'never' }, null, boardId, viewer)
    }
  }
}

export function touchSeat(body: Record<string, unknown>): void {
  seatRegistry.touch({
    bridgeId: typeof body.bridge_id === 'string' ? body.bridge_id : null,
    agent: typeof body.agent === 'string' ? body.agent : null,
    as: typeof body.as === 'string' ? body.as : null
  })
}
