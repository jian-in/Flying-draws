// 提议层：用户批准或拒绝 agent 的改动。
import { CaptureUpdateAction, newElementWith } from '@excalidraw/excalidraw'
import type { PendingChanges, PlannedMove } from '../../../main/ops'
import { type Api, type HiddenMap, type SceneEl, type Loose, patch } from './types'
import { unmaskElements } from './scene'
import { applyChanges, resnapArrowsToElements } from './applyPlan'

export const GHOST_NUDGE_THRESHOLD = 24 // 落点框被拖动超过这么远，才告诉 agent"用户又调了落点"

export function nudgeWords(dx: number, dy: number): string {
  const horiz = dx > 0 ? '右' : '左'
  const vert = dy > 0 ? '下' : '上'
  // 主要方向至少占一半时才算上次要方向，免得 (40, 3) 说成"右下"
  if (Math.abs(dx) >= Math.abs(dy) * 2) return horiz
  if (Math.abs(dy) >= Math.abs(dx) * 2) return vert
  return `${horiz}${vert}`
}

// 用户对一个提议做了决定。接受：提议层上的元素变成正式内容（实线、不透明，仍是对应席位颜色），
// 并把提议里尚未被用户删掉标记框的改动真正执行；拒绝：全部删掉。返回用户删掉标记框取消的改动说明。
export function resolveProposal(api: Api, proposalId: string, accept: boolean, pending: PendingChanges | null, hidden: HiddenMap): string[] {
  const all = unmaskElements(api.getSceneElementsIncludingDeleted(), hidden)
  const liveIds = new Set(all.filter((el) => !el.isDeleted).map((el) => el.id))
  const skipped: string[] = []
  let working = all
  if (accept && pending) {
    const liveById = new Map(all.filter((el) => !el.isDeleted).map((el) => [el.id, el]))
    const approvedTargets = new Set<string>()
    for (const m of pending.markers ?? []) {
      if (liveIds.has(m.frameId)) {
        for (const t of m.targets) approvedTargets.add(t)
      } else {
        skipped.push(`不同意${m.summary}`)
      }
    }

    // 移动：原位标记框和落点框都还在才执行；落点框被用户拖过时，按拖到的位置算最终平移量
    let approvedMoves: PlannedMove[] = []
    const userAdjustedTargets = new Set<string>()
    const skippedMoveTargets = new Set<string>()
    const ghosts = pending.moveGhosts ?? []
    if (ghosts.length) {
      for (const g of ghosts) {
        if (!liveById.has(g.frameId)) {
          // 原位框被删：上面已经记了"不同意…"，这里不重复说
          skippedMoveTargets.add(g.targetKey)
          continue
        }
        const ghostNow = liveById.get(g.ghostId)
        if (!ghostNow) {
          skipped.push(`不同意${g.summary}`)
          skippedMoveTargets.add(g.targetKey)
          continue
        }
        const userDx = ghostNow.x - g.x
        const userDy = ghostNow.y - g.y
        const base = (pending.moves ?? []).find((m) => m.targetKey === g.targetKey)
        const zero = { x: 0, y: 0, w: 0, h: 0 }
        approvedMoves.push({
          ...(base ?? { id: g.targetKey, kind: 'node' as const, fromBbox: zero, toBbox: zero }),
          targetKey: g.targetKey,
          elementIds: g.elementIds,
          dx: g.dx + userDx,
          dy: g.dy + userDy,
          // 以用户确认时落点框的左上角为准，不受等待期间原位置微差和主进程尺寸估算偏差的影响
          toTopLeft: { x: ghostNow.x, y: ghostNow.y }
        })
        const nudge = Math.hypot(userDx, userDy)
        if (nudge >= 1) userAdjustedTargets.add(g.targetKey)
        if (nudge >= GHOST_NUDGE_THRESHOLD) {
          skipped.push(`接受${g.summary}，但把落点又往${nudgeWords(userDx, userDy)}微调了（${Math.round(userDx)}, ${Math.round(userDy)}）`)
        }
      }
    } else if (pending.moves?.length) {
      // 兼容没有落点框的旧提议：跟着原位标记框走
      approvedMoves = pending.moves.filter((m) => approvedTargets.has(m.targetKey))
      for (const m of pending.moves) if (!approvedTargets.has(m.targetKey)) skippedMoveTargets.add(m.targetKey)
    }

    // 被否决的目标：移动被否决的，加上原位标记框被删掉的那些改动（改样式、改字、删除）
    const skippedTargets = new Set(skippedMoveTargets)
    for (const m of pending.markers ?? []) if (!liveIds.has(m.frameId)) for (const t of m.targets) skippedTargets.add(t)

    // 主进程预先算好的绕障路线只对"按计划落点"成立：落点被微调或移动被否决时丢掉，交给 applyChanges 按实际位置重贴
    const endpointsOf = (arrowId: string): string[] => {
      const el = liveById.get(arrowId) as Loose | undefined
      return [el?.startBinding?.elementId, el?.endBinding?.elementId].filter((id): id is string => Boolean(id))
    }
    const stale = (id: string) => userAdjustedTargets.has(id) || skippedMoveTargets.has(id)
    const validReroutes = (pending.reroutes ?? []).filter((r) => !endpointsOf(r.arrowId).some(stale))
    // 这个提议里新画的连线：applyChanges 里先不动（它们是按计划落点画的，不能再跟着平移一遍），
    // 等改动全部落定后，再按端点的真实最终框体统一重贴
    const proposalArrows = (all as Loose[])
      .filter((el) => {
        const mark = el.customData?.flyingdraws
        return !el.isDeleted && el.type === 'arrow' && mark?.layer === 'proposal' && mark?.proposal === proposalId
      })
      .map((el) => el.id)

    working = applyChanges(all, {
      updates: (pending.updates ?? []).filter((u) => approvedTargets.has(u.elementId)),
      textEdits: (pending.textEdits ?? []).filter((t) => approvedTargets.has(t.elementId)),
      styles: (pending.styles ?? []).filter((s) => approvedTargets.has(s.elementId)),
      deletes: (pending.deletes ?? []).filter((id) => approvedTargets.has(id)),
      moves: approvedMoves,
      reroutes: validReroutes,
      pinnedArrows: proposalArrows
    })

    // 端点涉及本提议改动（批准的、否决的、微调过落点的）的提议连线，按最终框体重贴两端；
    // 端点的移动被否决或落点被微调时，原来按计划落点算的绕障拐点已经过期，一并丢掉
    const touchedTargets = new Set([...approvedTargets, ...skippedTargets, ...userAdjustedTargets, ...approvedMoves.flatMap((m) => m.elementIds)])
    const resnapIds = proposalArrows.filter((id) => endpointsOf(id).some((end) => touchedTargets.has(end)))
    const dropInterior = new Set(resnapIds.filter((id) => endpointsOf(id).some(stale)))
    working = resnapArrowsToElements(working, resnapIds, dropInterior)
  }

  const isProposed = (el: SceneEl): boolean => {
    const mark = el.customData?.flyingdraws
    return !el.isDeleted && mark?.layer === 'proposal' && mark?.proposal === proposalId
  }
  // 原位标记框和移动落点框（含框里的提示文字）都只是预览，接受或拒绝后一律删掉
  const isHelperEl = (el: SceneEl): boolean => {
    const role = el.customData?.flyingdraws?.role
    return role === 'marker' || role === 'move-ghost'
  }
  const settled = working.map((el) => {
    if (isProposed(el)) {
      if (!accept || isHelperEl(el)) return newElementWith(el, { isDeleted: true })
      const prevMark = el.customData?.flyingdraws
      return newElementWith(el, {
        opacity: 100,
        // 照图还原时本来就是虚线的线条，接受后仍是虚线
        strokeStyle: prevMark?.dashed ? 'dashed' : 'solid',
        customData: {
          ...el.customData,
          flyingdraws: {
            author: 'agent',
            ...(typeof prevMark?.agent === 'string' && prevMark.agent ? { agent: prevMark.agent } : {}),
            ...(prevMark?.seat ? { seat: true } : {}),
            ...(typeof prevMark?.color === 'string' && prevMark.color ? { color: prevMark.color } : {}),
            ...(prevMark?.traced ? { traced: true } : {}),
            ...(prevMark?.dashed ? { dashed: true } : {}),
            layer: 'final'
          }
        }
      })
    }
    return el
  })
  // 结算后再统一清一遍悬空绑定：指向任何已删元素（本次结算删掉的提议/预览元素，
  // 以及用户在提议挂起期间自己删掉的提议元素）的反向记录和箭头端点都要去掉。
  // 转正的提议元素也要过这一遍，例如用户只删了提议里的新节点、保留了连向它的提议连线。
  const dead = new Set(settled.filter((el) => el.isDeleted).map((el) => el.id))
  const elements = settled.map((el) => {
    if (el.isDeleted || !dead.size) return el
    const changes: Record<string, unknown> = {}
    if (el.boundElements?.some((b) => dead.has(b.id))) changes.boundElements = el.boundElements.filter((b) => !dead.has(b.id))
    if (el.type === 'arrow') {
      const arrow = el as Loose
      if (arrow.startBinding && dead.has(arrow.startBinding.elementId)) changes.startBinding = null
      if (arrow.endBinding && dead.has(arrow.endBinding.elementId)) changes.endBinding = null
    }
    return Object.keys(changes).length ? patch(el, changes) : el
  })
  api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
  return skipped
}
