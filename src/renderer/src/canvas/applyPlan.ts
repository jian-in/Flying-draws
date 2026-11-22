// 把主进程算好的绘图计划落到 Excalidraw 场景上。
import { flushSync } from 'react-dom'
import { CaptureUpdateAction, convertToExcalidrawElements, newElementWith } from '@excalidraw/excalidraw'
import { AUTO_TEXT_MAX_W, containerWidthFor, exitPoint, polylineMidpoint, type ShapeBox } from '../../../main/geometry'
import type { DrawPlan, PlannedMove, PlannedReroute } from '../../../main/ops'
import { type Api, type HiddenMap, type AuthorFilter, type SkeletonList, type SceneEl, type Loose, patch } from './types'
import { unmaskElements, elementBox, snapshot, USER_BUSY_WAIT_MS, DEFERRED_NOTICE_MS, sleep, userIsBusy, showElements, AGENT_COLOR, PROPOSAL_OPACITY } from './scene'
import { extractSeats, isDynamicSeats, applyAuthorFilter } from './filters'

// 元素在这一批改动里的几何变化。箭头跟随、标签重定位都只看这张表。
// pureTranslate 为 true 表示形状和大小都没变，只是整体平移了 (dx, dy)；
// 改了大小或形状（含自动扩宽）时为 false，dx/dy 仍记录累计平移量，用来判断要不要丢掉过期的自动拐点。
export interface GeomChange {
  after: ShapeBox
  pureTranslate: boolean
  dx: number
  dy: number
}

export const CONTAINER_TYPES = ['rectangle', 'ellipse', 'diamond']

export const SAME_DELTA_EPS = 0.5

// 执行计划里的样式修改、改字、独立文字修改、平移和删除。
// 删节点时，绑在上面的文字和连着它的 agent 连线一起删；用户画的连线留着，只把那一头松开。
// forceResnap：要强制把两端重新贴到端点元素当前轮廓上的箭头（提议里被否决的移动留下的新连线）。
// pinnedArrows：已经按最终位置画好、第 5 步不要再动的箭头（提议里按计划落点新画的连线）。
export function applyChanges(
  elements: SceneEl[],
  plan: Pick<DrawPlan, 'updates' | 'textEdits' | 'styles' | 'deletes'> & {
    moves?: PlannedMove[]
    reroutes?: PlannedReroute[]
    forceResnap?: string[]
    pinnedArrows?: string[]
  }
): SceneEl[] {
  const moves = plan.moves ?? []
  const forced = new Set(plan.forceResnap ?? [])
  if (!plan.updates.length && !plan.textEdits.length && !plan.styles.length && !plan.deletes.length && !moves.length && !forced.size) {
    return elements
  }
  const byId = new Map(elements.map((el) => [el.id, el]))
  const gone = new Set(plan.deletes)
  const goneNodes = new Set(plan.deletes.filter((id) => byId.get(id)?.type !== 'arrow'))
  for (const el of elements as Loose[]) {
    if (el.isDeleted || el.type !== 'arrow' || el.customData?.flyingdraws?.author !== 'agent') continue
    if ((el.startBinding && goneNodes.has(el.startBinding.elementId)) || (el.endBinding && goneNodes.has(el.endBinding.elementId))) gone.add(el.id)
  }

  const replaced = new Map<string, SceneEl>()
  const added: SceneEl[] = []
  const geom = new Map<string, GeomChange>()
  const styledById = new Map(plan.styles.map((s) => [s.elementId, s]))
  const current = (id: string): Loose | undefined => (replaced.get(id) ?? byId.get(id)) as Loose | undefined
  const boxOfEl = (el: Loose): ShapeBox => ({ x: el.x, y: el.y, w: el.width, h: el.height, shape: el.type })
  // 绑在某个容器（节点或箭头）上的文字：先找这一批刚生成的，再找画布上原有且没被删掉的
  const boundTextOf = (containerId: string): { el: Loose; addedAt: number } | null => {
    const at = added.findIndex((el) => (el as Loose).containerId === containerId)
    if (at >= 0) return { el: added[at] as Loose, addedAt: at }
    const old = (elements as Loose[]).find((el) => !el.isDeleted && el.type === 'text' && el.containerId === containerId && !gone.has(el.id))
    return old ? { el: current(old.id) ?? old, addedAt: -1 } : null
  }
  const setBoundText = (hit: { el: Loose; addedAt: number }, changes: Record<string, unknown>): void => {
    if (hit.addedAt >= 0) added[hit.addedAt] = { ...hit.el, ...changes } as unknown as SceneEl
    else replaced.set(hit.el.id, patch(hit.el, changes))
  }
  const noteGeom = (id: string, after: ShapeBox): void => {
    const prev = geom.get(id)
    geom.set(id, { after, pureTranslate: false, dx: prev?.dx ?? 0, dy: prev?.dy ?? 0 })
  }

  // 1. 先改样式（颜色、填充、形状、宽高），后面的文字重排要用到新形状和尺寸
  for (const s of plan.styles) {
    const target = byId.get(s.elementId) as Loose | undefined
    if (!target || target.isDeleted || gone.has(target.id)) continue
    const newW = s.w ?? target.width
    const newH = s.h ?? target.height
    const resized = s.w !== undefined || s.h !== undefined
    const newX = resized ? target.x + target.width / 2 - newW / 2 : target.x
    const newY = resized ? target.y + target.height / 2 - newH / 2 : target.y
    const nextType = s.shape ?? target.type
    const stylePatch: Record<string, unknown> = {
      ...(s.color ? { strokeColor: s.color } : {}),
      ...(s.fill
        ? {
            backgroundColor: s.fill,
            ...(s.fill !== 'transparent' ? { fillStyle: target.fillStyle || 'solid' } : {})
          }
        : {}),
      ...(s.shape ? { type: s.shape } : {}),
      ...(resized ? { x: newX, y: newY, width: newW, height: newH } : {})
    }
    replaced.set(target.id, patch(target, stylePatch))
    if (s.color) {
      const boundText = (elements as Loose[]).find((el) => !el.isDeleted && el.type === 'text' && el.containerId === target.id)
      if (boundText) replaced.set(boundText.id, patch(boundText, { strokeColor: s.color }))
    }
    if (CONTAINER_TYPES.includes(nextType) && (s.shape || resized)) {
      noteGeom(target.id, { x: newX, y: newY, w: newW, h: newH, shape: nextType })
    }
  }

  // 2. 节点/连线改字或节点改形后的文字重排：不直接改旧文字，让 Excalidraw 重新算尺寸并替换。
  //    节点放不下新文字时自动扩宽（只扩不缩，文字区最宽 AUTO_TEXT_MAX_W），再不够就折行撑高；宽高都保持中心不动。
  //    同一批 set_style 显式给了宽或高的那一维，以显式值为准。
  for (const u of plan.updates) {
    const target = current(u.elementId)
    if (!target || target.isDeleted || gone.has(target.id)) continue
    const old = (elements as Loose[]).find((el) => !el.isDeleted && el.type === 'text' && el.containerId === target.id)
    if (old) gone.add(old.id)
    let bound = (target.boundElements ?? []).filter((b) => b.id !== old?.id)
    const label = u.label ?? (u.relayout && old ? ((old as Loose & { originalText?: string }).originalText ?? (old as Loose & { text?: string }).text ?? null) : null)
    const oldFontSize = (old as (Loose & { fontSize?: number }) | undefined)?.fontSize
    const labelProps = { text: label, ...(oldFontSize ? { fontSize: oldFontSize } : {}) }
    const grow: Record<string, unknown> = {}
    if (label) {
      let text: SceneEl | undefined
      if (target.type === 'arrow') {
        const skeleton = { type: 'arrow', id: 'sl_tmp', x: target.x, y: target.y, width: target.width, height: target.height, points: target.points, label: labelProps }
        const made = convertToExcalidrawElements([skeleton] as unknown as SkeletonList, { regenerateIds: false })
        text = made.find((el) => el.type === 'text')
      } else {
        const explicitW = styledById.get(target.id)?.w !== undefined
        const explicitH = styledById.get(target.id)?.h !== undefined
        let nextW = target.width
        if (!explicitW) {
          const measured = convertToExcalidrawElements(
            [{ type: 'text', id: 'sl_m', x: 0, y: 0, text: label, ...(oldFontSize ? { fontSize: oldFontSize } : {}) }] as unknown as SkeletonList,
            { regenerateIds: false }
          )[0]
          const naturalW = measured?.width ?? 0
          nextW = Math.max(target.width, containerWidthFor(target.type, Math.min(naturalW, AUTO_TEXT_MAX_W), 120))
        }
        // 按新宽度折行一次，拿到放得下文字所需的高度
        const sized = convertToExcalidrawElements(
          [{ type: target.type, id: 'sl_tmp', x: target.x, y: target.y, width: nextW, height: target.height, label: labelProps }] as unknown as SkeletonList,
          { regenerateIds: false }
        )
        const sizedBox = sized.find((el) => el.type !== 'text')
        const nextH = explicitH ? target.height : Math.max(target.height, sizedBox?.height ?? target.height)
        const nextX = target.x + target.width / 2 - nextW / 2
        const nextY = target.y + target.height / 2 - nextH / 2
        // 用最终的位置和大小再生成一次文字，保证它在容器里居中
        const made = convertToExcalidrawElements(
          [{ type: target.type, id: 'sl_tmp', x: nextX, y: nextY, width: nextW, height: nextH, label: labelProps }] as unknown as SkeletonList,
          { regenerateIds: false }
        )
        text = made.find((el) => el.type === 'text')
        // 显式高度放不下文字时 Excalidraw 会把临时容器撑高，文字就不在真实容器的正中了，这里按真实高度摆回去
        if (text) text = { ...text, y: nextY + nextH / 2 - text.height / 2 } as SceneEl
        if (nextW !== target.width || nextH !== target.height) {
          Object.assign(grow, { x: nextX, y: nextY, width: nextW, height: nextH })
          noteGeom(target.id, { x: nextX, y: nextY, w: nextW, h: nextH, shape: target.type })
        }
      }
      if (text) {
        added.push({
          ...text,
          id: u.textId,
          containerId: target.id,
          strokeColor: target.strokeColor,
          opacity: target.opacity,
          customData: target.customData
        } as unknown as SceneEl)
        bound = [...bound, { type: 'text', id: u.textId }]
      }
    }
    replaced.set(target.id, patch(target, { ...grow, boundElements: bound }))
  }

  // 3. 修改独立文字的内容并重算宽高
  for (const te of plan.textEdits) {
    const target = current(te.elementId) as (Loose & { fontSize?: number; fontFamily?: number }) | undefined
    if (!target || target.isDeleted || gone.has(target.id)) continue
    const made = convertToExcalidrawElements(
      [
        {
          type: 'text',
          id: 'sl_tmp',
          x: target.x,
          y: target.y,
          text: te.text,
          ...(target.fontSize ? { fontSize: target.fontSize } : {}),
          ...(target.fontFamily ? { fontFamily: target.fontFamily } : {})
        }
      ] as unknown as SkeletonList,
      { regenerateIds: false }
    )
    const measured = made[0]
    replaced.set(
      target.id,
      patch(target, {
        text: te.text,
        originalText: te.text,
        ...(measured ? { width: measured.width, height: measured.height } : {})
      })
    )
  }

  // 4. 平移。节点里的文字跟着节点走（updateScene 不会替我们同步绑定文字的绝对坐标）
  const translated = new Set<string>()
  for (const m of moves) {
    // 手绘组有成员已经不在了：整条移动跳过，不做半截
    const members = m.elementIds.map((id) => current(id))
    if (members.some((cur, i) => !cur || cur.isDeleted || gone.has(m.elementIds[i]))) continue
    // 给了目标左上角时，按改样式/自动扩宽之后的真实外接框对齐它，消除主进程估算尺寸带来的偏差
    let mdx = m.dx
    let mdy = m.dy
    if (m.toTopLeft) {
      const boxes = members.map((cur) => elementBox(cur!))
      mdx = m.toTopLeft.x - Math.min(...boxes.map((b) => b.x))
      mdy = m.toTopLeft.y - Math.min(...boxes.map((b) => b.y))
    }
    if (!mdx && !mdy) continue
    for (const id of m.elementIds) {
      if (translated.has(id)) continue
      const cur = current(id)!
      translated.add(id)
      const nextX = cur.x + mdx
      const nextY = cur.y + mdy
      replaced.set(id, patch(cur, { x: nextX, y: nextY }))
      if (CONTAINER_TYPES.includes(cur.type)) {
        const hit = boundTextOf(id)
        if (hit && !translated.has(hit.el.id)) {
          translated.add(hit.el.id)
          setBoundText(hit, { x: hit.el.x + mdx, y: hit.el.y + mdy })
        }
      }
      const prev = geom.get(id)
      if (prev) {
        geom.set(id, {
          after: { ...prev.after, x: prev.after.x + mdx, y: prev.after.y + mdy },
          pureTranslate: false,
          dx: prev.dx + mdx,
          dy: prev.dy + mdy
        })
      } else {
        geom.set(id, { after: { x: nextX, y: nextY, w: cur.width, h: cur.height, shape: cur.type }, pureTranslate: true, dx: mdx, dy: mdy })
      }
    }
  }

  // 5. 端点元素改了形状、大小或位置时，让连着它的箭头跟上，并把连线上的文字摆回箭头中点
  if (geom.size > 0 || forced.size > 0) {
    const rerouteById = new Map((plan.reroutes ?? []).map((r) => [r.arrowId, r]))
    const nodeBox = (id: string): ShapeBox | null => {
      if (gone.has(id)) return null
      const g = geom.get(id)
      if (g) return g.after
      const el = current(id)
      if (!el || el.isDeleted) return null
      return boxOfEl(el)
    }
    const centerOf = (b: ShapeBox): [number, number] => [b.x + b.w / 2, b.y + b.h / 2]
    const pinned = new Set(plan.pinnedArrows ?? [])
    for (const original of elements as Loose[]) {
      if (original.isDeleted || gone.has(original.id) || original.type !== 'arrow' || pinned.has(original.id)) continue
      const el = current(original.id)!
      const fromId = el.startBinding?.elementId
      const toId = el.endBinding?.elementId
      const gFrom = fromId ? geom.get(fromId) : undefined
      const gTo = toId ? geom.get(toId) : undefined
      const isForced = forced.has(el.id)
      if (!gFrom && !gTo && !isForced) continue
      const elbowed = Boolean((el as Loose & { elbowed?: boolean }).elbowed)

      // 两端一起平移了同样的距离：整条箭头连同拐点、弧度、肘形线段原样平移
      if (
        !isForced &&
        gFrom?.pureTranslate &&
        gTo?.pureTranslate &&
        Math.abs(gFrom.dx - gTo.dx) < SAME_DELTA_EPS &&
        Math.abs(gFrom.dy - gTo.dy) < SAME_DELTA_EPS
      ) {
        if (translated.has(el.id)) continue // 箭头自己就在这批平移名单里（如图片的标注箭头），已经挪过了
        replaced.set(el.id, patch(el, { x: el.x + gFrom.dx, y: el.y + gFrom.dy }))
        const hit = boundTextOf(el.id)
        if (hit) setBoundText(hit, { x: hit.el.x + gFrom.dx, y: hit.el.y + gFrom.dy })
        continue
      }

      // 只动了一端、两端动得不一样，或者端点改了大小/形状
      const fromBox = fromId ? nodeBox(fromId) : null
      const toBox = toId ? nodeBox(toId) : null
      if (!fromBox && !toBox) continue
      const pts = (el.points && el.points.length >= 2 ? el.points : [[0, 0], [el.width, el.height]]).map(
        ([px, py]): [number, number] => [el.x + px, el.y + py]
      )
      const shifted = (g?: GeomChange) => Boolean(g && (g.dx !== 0 || g.dy !== 0))
      // 主进程的路线不用于：肘形箭头、用户手画的多折点箭头（保留用户的拐法）、绑定关系已经变了的箭头
      const candidate = rerouteById.get(el.id)
      const userBends = el.customData?.flyingdraws?.author !== 'agent' && pts.length > 2
      const rebound =
        Boolean(candidate?.fromElementId && candidate.fromElementId !== fromId) || Boolean(candidate?.toElementId && candidate.toElementId !== toId)
      const reroute = elbowed || userBends || rebound ? undefined : candidate
      let interior: [number, number][]
      let routeChanged = false
      let rerouteEnds: [[number, number], [number, number]] | null = null
      if (reroute && reroute.points.length >= 2) {
        // 主进程算好的绕障拐点；两端再按页面上的真实轮廓（可能刚自动扩宽过）贴一次
        const abs = reroute.points.map(([px, py]): [number, number] => [reroute.x + px, reroute.y + py])
        interior = abs.slice(1, -1)
        rerouteEnds = [abs[0], abs[abs.length - 1]]
        routeChanged = true
      } else if (el.customData?.flyingdraws?.author === 'agent' && pts.length > 2 && !elbowed && (shifted(gFrom) || shifted(gTo) || isForced)) {
        // agent 自动生成的绕障拐点是按旧位置算的，端点挪走后已经过期，改成直线
        interior = []
        routeChanged = true
      } else {
        // 用户画的折点保持世界坐标不动，只重贴变化的那一端。
        // 例外：两端平移了同样的距离（只是有一端同时改了大小，没进情况 A），折点也跟着平移，免得线被拉歪
        interior = pts.slice(1, -1)
        if (
          gFrom &&
          gTo &&
          shifted(gFrom) &&
          Math.abs(gFrom.dx - gTo.dx) < SAME_DELTA_EPS &&
          Math.abs(gFrom.dy - gTo.dy) < SAME_DELTA_EPS &&
          !translated.has(el.id)
        ) {
          interior = interior.map(([px, py]): [number, number] => [px + gFrom.dx, py + gFrom.dy])
        }
      }
      const firstAway: [number, number] = interior[0] ?? (toBox ? centerOf(toBox) : (rerouteEnds?.[1] ?? pts[pts.length - 1]))
      const lastAway: [number, number] = interior[interior.length - 1] ?? (fromBox ? centerOf(fromBox) : (rerouteEnds?.[0] ?? pts[0]))
      const fromChanged = Boolean(fromBox && (gFrom || isForced || routeChanged))
      const toChanged = Boolean(toBox && (gTo || isForced || routeChanged))
      const nextStart = fromChanged ? exitPoint(fromBox!, firstAway[0], firstAway[1], 8) : (rerouteEnds?.[0] ?? pts[0])
      const nextEnd = toChanged ? exitPoint(toBox!, lastAway[0], lastAway[1], 8) : (rerouteEnds?.[1] ?? pts[pts.length - 1])
      const absPts: [number, number][] = [nextStart, ...interior, nextEnd]
      const [sx, sy] = absPts[0]
      const relPts = absPts.map(([px, py]): [number, number] => [px - sx, py - sy])
      const xs = relPts.map((p) => p[0])
      const ys = relPts.map((p) => p[1])
      replaced.set(
        el.id,
        patch(el, {
          x: sx,
          y: sy,
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
          points: relPts,
          // 拐点被丢掉后不再是曲线；肘形箭头手动改了点，原来的正交线段记录作废，交给 Excalidraw 下次交互时重算
          ...(routeChanged && interior.length === 0 ? { roundness: null } : {}),
          ...(elbowed ? { fixedSegments: null } : {})
        })
      )
      // 连线上的文字：Excalidraw 不会因为 points 变了就挪它，按新折线的中点摆回去
      const hit = boundTextOf(el.id)
      if (hit) {
        const [midX, midY] = polylineMidpoint(sx, sy, relPts)
        setBoundText(hit, { x: midX - hit.el.width / 2, y: midY - hit.el.height / 2 })
      }
    }
  }

  for (const el of elements as Loose[]) if (!el.isDeleted && el.type === 'text' && el.containerId && gone.has(el.containerId)) gone.add(el.id)

  const kept = elements.map((original) => {
    let el = (replaced.get(original.id) ?? original) as Loose
    if (gone.has(el.id)) return el.isDeleted ? el : patch(el, { isDeleted: true })
    if (el.boundElements?.some((b) => gone.has(b.id))) el = patch(el, { boundElements: el.boundElements.filter((b) => !gone.has(b.id)) }) as Loose
    if (el.type === 'arrow') {
      if (el.startBinding && gone.has(el.startBinding.elementId)) el = patch(el, { startBinding: null }) as Loose
      if (el.endBinding && gone.has(el.endBinding.elementId)) el = patch(el, { endBinding: null }) as Loose
    }
    return el
  })
  return [...kept, ...added]
}

// 把一批箭头的两端重新贴到端点元素当前（最终）的轮廓上，并把连线上的文字摆回中点。
// 默认保留中间拐点；dropInteriorFor 里的箭头丢掉中间拐点（端点落点变了，原来的绕障拐点已经过期）。
export function resnapArrowsToElements(elements: SceneEl[], arrowIds: Iterable<string>, dropInteriorFor: ReadonlySet<string> = new Set()): SceneEl[] {
  const ids = new Set(arrowIds)
  if (!ids.size) return elements
  const live = new Map((elements as Loose[]).filter((el) => !el.isDeleted).map((el) => [el.id, el]))
  const labelOf = new Map<string, Loose>()
  for (const el of live.values()) if (el.type === 'text' && el.containerId && ids.has(el.containerId)) labelOf.set(el.containerId, el)
  const shapeOf = (id: string | undefined): ShapeBox | null => {
    const el = id ? live.get(id) : undefined
    if (!el) return null
    const b = elementBox(el)
    return { x: b.x, y: b.y, w: b.w, h: b.h, shape: el.type }
  }
  const centerOf = (b: ShapeBox): [number, number] => [b.x + b.w / 2, b.y + b.h / 2]
  const out = new Map<string, SceneEl>()
  for (const id of ids) {
    const el = live.get(id)
    if (!el || el.type !== 'arrow') continue
    const fromBox = shapeOf(el.startBinding?.elementId)
    const toBox = shapeOf(el.endBinding?.elementId)
    if (!fromBox && !toBox) continue
    const abs = (el.points && el.points.length >= 2 ? el.points : [[0, 0], [el.width, el.height]]).map(
      ([px, py]): [number, number] => [el.x + px, el.y + py]
    )
    const drop = dropInteriorFor.has(id) && abs.length > 2
    const interior = drop ? [] : abs.slice(1, -1)
    const firstAway = interior[0] ?? (toBox ? centerOf(toBox) : abs[abs.length - 1])
    const lastAway = interior[interior.length - 1] ?? (fromBox ? centerOf(fromBox) : abs[0])
    const start = fromBox ? exitPoint(fromBox, firstAway[0], firstAway[1], 8) : abs[0]
    const end = toBox ? exitPoint(toBox, lastAway[0], lastAway[1], 8) : abs[abs.length - 1]
    const absPts: [number, number][] = [start, ...interior, end]
    const [sx, sy] = absPts[0]
    const relPts = absPts.map(([px, py]): [number, number] => [px - sx, py - sy])
    const xs = relPts.map((p) => p[0])
    const ys = relPts.map((p) => p[1])
    out.set(
      id,
      patch(el, {
        x: sx,
        y: sy,
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
        points: relPts,
        ...(drop ? { roundness: null } : {}),
        ...((el as Loose & { elbowed?: boolean }).elbowed ? { fixedSegments: null } : {})
      })
    )
    const label = labelOf.get(id)
    if (label) {
      const [midX, midY] = polylineMidpoint(sx, sy, relPts)
      out.set(label.id, patch(label, { x: midX - label.width / 2, y: midY - label.height / 2 }))
    }
  }
  return out.size ? elements.map((el) => out.get(el.id) ?? el) : elements
}

// 把主进程排好的绘图计划画到画布上。
// proposalId 不为空时画在提议层上，等用户确认。
export async function applyPlan(
  api: Api,
  plan: DrawPlan,
  proposalId: string | null,
  agent: string | null,
  seat: boolean,
  color: string | null,
  hidden: HiddenMap,
  getFilter: () => AuthorFilter,
  preferredAgent: string | null,
  isStale: () => boolean,
  onDeferredChange?: (state: { agent: string | null; editingText: boolean } | null) => void
): Promise<{ sceneJson: string }> {
  // 用户优先：等用户手上的动作做完再画；等超过 400ms 才显示等待提示
  const startedAt = Date.now()
  const deadline = startedAt + USER_BUSY_WAIT_MS
  let notified = false
  let waited = false
  // 记下要改动/移动/删除的目标现在的样子；等用户松手后核对，期间被用户动过就不能照旧执行
  const modified = new Set(plan.modifiedRefs)
  const signature = (el: SceneEl): string => `${el.isDeleted ? 1 : 0}|${el.x}|${el.y}|${el.width}|${el.height}|${el.version}`
  const before = new Map(
    api
      .getSceneElementsIncludingDeleted()
      .filter((el) => modified.has(el.id))
      .map((el) => [el.id, signature(el)])
  )
  try {
    while (userIsBusy(api)) {
      if (isStale()) throw new Error('the active board or scene changed while waiting; call canvas_read and try again')
      waited = true
      if (Date.now() > deadline) throw new Error('the user is in the middle of drawing; wait a moment and call canvas_draw again')
      if (!notified && Date.now() - startedAt >= DEFERRED_NOTICE_MS) {
        notified = true
        onDeferredChange?.({ agent, editingText: Boolean(api.getAppState().editingTextElement) })
      }
      await sleep(100)
    }
  } finally {
    if (notified) onDeferredChange?.(null)
  }

  if (isStale()) throw new Error('the active board or scene changed while waiting; call canvas_read and try again')

  if (waited && before.size) {
    const now = new Map(api.getSceneElementsIncludingDeleted().map((el) => [el.id, el]))
    for (const [id, sig] of before) {
      const el = now.get(id)
      if (!el || signature(el) !== sig) throw new Error('an element these ops modify was just changed by the user; call canvas_read and try again')
    }
  }

  const current = unmaskElements(api.getSceneElementsIncludingDeleted(), hidden)
  const alive = new Set(current.filter((el) => !el.isDeleted).map((el) => el.id))
  for (const ref of [...plan.existingRefs, ...(plan.stableRefs ?? [])]) {
    if (!alive.has(ref)) throw new Error('an element these ops refer to was just deleted by the user; call canvas_read and try again')
  }

  // 照图还原（trace_image）出来的元素带着原图的颜色、填充、字号，画的时候保留，不换成席位颜色
  const lines = plan.lines ?? []
  const bound = (l: (typeof lines)[number]) => Boolean(l.fromElementId || l.toElementId)
  const skeletons = [
    ...plan.nodes.map((n) => ({
      type: n.shape,
      id: n.elementId,
      x: n.x,
      y: n.y,
      width: n.w,
      height: n.h,
      ...(n.color ? { strokeColor: n.color } : {}),
      ...(n.fill ? (n.fill === 'transparent' ? { backgroundColor: 'transparent' } : { backgroundColor: n.fill, fillStyle: 'solid' as const }) : {}),
      ...(n.label
        ? { label: { text: n.label, ...(n.fontSize ? { fontSize: n.fontSize } : {}), ...(n.color ? { strokeColor: n.color } : {}) } }
        : {})
    })),
    // 有箭头或要绑到方框上的画成箭头（只有箭头能绑定），其余画成普通折线
    ...lines.map((l) => ({
      type: l.startArrow || l.endArrow || bound(l) ? ('arrow' as const) : ('line' as const),
      id: l.elementId,
      x: l.x,
      y: l.y,
      width: Math.max(...l.points.map((p) => p[0])) - Math.min(...l.points.map((p) => p[0])),
      height: Math.max(...l.points.map((p) => p[1])) - Math.min(...l.points.map((p) => p[1])),
      points: l.points,
      ...(l.startArrow || l.endArrow || bound(l)
        ? { startArrowhead: l.startArrow ? ('arrow' as const) : null, endArrowhead: l.endArrow ? ('arrow' as const) : null }
        : {}),
      ...(l.color ? { strokeColor: l.color } : {}),
      ...(l.dashed ? { strokeStyle: 'dashed' as const } : {})
    })),
    ...plan.edges.map((e) => ({
      type: 'arrow' as const,
      id: e.elementId,
      x: e.x,
      y: e.y,
      width: Math.max(...e.points.map((p) => p[0])) - Math.min(...e.points.map((p) => p[0])),
      height: Math.max(...e.points.map((p) => p[1])) - Math.min(...e.points.map((p) => p[1])),
      points: e.points,
      // 有拐点的连线画成圆滑的曲线，和用户手画的箭头一个样子
      ...(e.points.length > 2 ? { roundness: { type: 2 } } : {}),
      endArrowhead: 'arrow' as const,
      ...(e.label ? { label: { text: e.label } } : {})
    })),
    ...plan.texts.map((t) => ({
      type: 'text' as const,
      id: t.elementId,
      x: t.x,
      y: t.y,
      text: t.text,
      ...(t.fontSize ? { fontSize: t.fontSize } : {}),
      ...(t.color ? { strokeColor: t.color } : {})
    }))
  ] as unknown as SkeletonList
  const created = skeletons.length ? convertToExcalidrawElements(skeletons, { regenerateIds: false }) : []

  // 标上"agent 画的"和席位信息，并把箭头两端绑到节点上（这样用户拖节点时箭头会跟着走）
  const edgeById = new Map(plan.edges.map((e) => [e.elementId, e]))
  const arrowsOn = new Map<string, { id: string; type: 'arrow' }[]>()
  const attach = (nodeId: string, arrowId: string) => {
    const existing = arrowsOn.get(nodeId) ?? []
    if (!existing.some((item) => item.id === arrowId)) {
      arrowsOn.set(nodeId, [...existing, { id: arrowId, type: 'arrow' }])
    }
  }
  const strokeColor = color || AGENT_COLOR
  const look = proposalId
    ? { strokeColor, opacity: PROPOSAL_OPACITY, strokeStyle: 'dashed' as const }
    : { strokeColor }
  const seatFields = {
    ...(agent ? { agent } : {}),
    ...(seat ? { seat: true } : {}),
    ...(color ? { color } : {})
  }
  const mark = proposalId
    ? { author: 'agent', ...seatFields, layer: 'proposal', proposal: proposalId }
    : { author: 'agent', ...seatFields, layer: 'final' }
  const traced = new Set([
    ...plan.nodes.filter((n) => n.traced).map((n) => n.elementId),
    ...plan.texts.filter((t) => t.traced).map((t) => t.elementId),
    ...lines.map((l) => l.elementId)
  ])
  const lineById = new Map(lines.map((l) => [l.elementId, l]))
  const fresh = created.map((el) => {
    // 照图还原的元素（含方框里的文字）保留自己的颜色；提议时照样是虚线半透明，接受后虚线框线恢复成原样
    const isTraced = traced.has(el.id) || (el.type === 'text' && el.containerId !== null && traced.has(el.containerId ?? ''))
    const line = lineById.get(el.id)
    const ownLook = isTraced ? (proposalId ? { opacity: PROPOSAL_OPACITY, strokeStyle: 'dashed' as const } : {}) : look
    const ownMark = isTraced ? { ...mark, traced: true, ...(line?.dashed ? { dashed: true } : {}) } : mark
    const tagged = { ...el, ...ownLook, customData: { ...el.customData, flyingdraws: ownMark } }
    if (line && el.type === 'arrow' && (line.fromElementId || line.toElementId)) {
      if (line.fromElementId) attach(line.fromElementId, el.id)
      if (line.toElementId) attach(line.toElementId, el.id)
      return {
        ...tagged,
        ...(line.fromElementId ? { startBinding: { elementId: line.fromElementId, focus: 0, gap: 4 } } : {}),
        ...(line.toElementId ? { endBinding: { elementId: line.toElementId, focus: 0, gap: 4 } } : {})
      }
    }
    const edge = edgeById.get(el.id)
    if (!edge || el.type !== 'arrow') return tagged
    attach(edge.fromElementId, el.id)
    attach(edge.toElementId, el.id)
    return {
      ...tagged,
      startBinding: { elementId: edge.fromElementId, focus: 0, gap: 8 },
      endBinding: { elementId: edge.toElementId, focus: 0, gap: 8 }
    }
  }) as SceneEl[]

  // 提议里的改动预览标记框：虚线框 + 上方一句说明文字，成组方便用户整处删掉表示不同意
  const markerSkeletons = plan.markers.flatMap((m) => [
    { type: 'rectangle' as const, id: m.frameId, x: m.x, y: m.y, width: m.w, height: m.h },
    { type: 'text' as const, id: m.noteId, x: m.x, y: m.y - 26, text: m.note }
  ]) as unknown as SkeletonList
  const markerMeta = new Map(plan.markers.flatMap((m) => [[m.frameId, m], [m.noteId, m]]))
  const markerElements = markerSkeletons.length
    ? convertToExcalidrawElements(markerSkeletons, { regenerateIds: false }).map((el) => {
        const m = markerMeta.get(el.id)!
        const markerColor = m.tone === 'delete' ? '#e03131' : strokeColor
        return {
          ...el,
          strokeColor: markerColor,
          backgroundColor: 'transparent',
          strokeStyle: 'dashed' as const,
          opacity: 75,
          groupIds: [`fd_mk_${m.frameId}`],
          customData: {
            ...el.customData,
            flyingdraws: { author: 'agent', ...seatFields, layer: 'proposal', proposal: proposalId, role: 'marker' }
          }
        } as unknown as SceneEl
      })
    : []

  // 提议里移动目标的落点框：虚线矩形 + 框内提示文字（绑定文字，用户拖框时文字原生跟随）。
  // 用户可以拖它微调落点，接受时以它的位置为准；删掉它表示不同意这次移动。
  // 不和原位标记框共用 groupIds，否则拖落点框会把原位框一起拖走；两者只靠 customData.moveOf 关联。
  const ghostElements = (plan.moveGhosts ?? []).flatMap((g) =>
    convertToExcalidrawElements(
      [{ type: 'rectangle', id: g.ghostId, x: g.x, y: g.y, width: g.w, height: g.h, label: { text: g.label } }] as unknown as SkeletonList,
      { regenerateIds: false }
    ).map(
      (el) =>
        ({
          ...el,
          strokeColor,
          ...(el.type === 'text' ? {} : { backgroundColor: 'transparent', strokeStyle: 'dashed' as const }),
          opacity: 65,
          customData: {
            ...el.customData,
            flyingdraws: { author: 'agent', ...seatFields, layer: 'proposal', proposal: proposalId, role: 'move-ghost', moveOf: g.frameId }
          }
        }) as unknown as SceneEl
    )
  )

  const withArrows = (el: SceneEl): SceneEl => {
    const add = arrowsOn.get(el.id)
    if (!add) return el
    return newElementWith(el, { boundElements: [...(el.boundElements ?? []), ...add] })
  }

  const kept = applyChanges(current.map(withArrows), plan)
  const freshWithArrows = fresh.map(withArrows)
  // 直接绘制时，新连线的两端按页面上的真实最终框体（含刚自动扩宽、刚平移的节点）再贴一次，保留主进程算好的中间绕障拐点
  const settledScene = proposalId
    ? [...kept, ...freshWithArrows]
    : resnapArrowsToElements([...kept, ...freshWithArrows], plan.edges.map((e) => e.elementId))
  const nextAll = [...settledScene, ...markerElements, ...ghostElements]
  if (hidden.size > 0) {
    hidden.clear()
    flushSync(() => {
      api.updateScene({ elements: current, captureUpdate: CaptureUpdateAction.NEVER })
    })
  }
  const filter = getFilter()
  if (filter !== 'all') {
    flushSync(() => {
      api.updateScene({
        elements: nextAll,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY // 用户可以用撤销去掉 agent 画的这一批
      })
    })
    applyAuthorFilter(api, filter, hidden, preferredAgent, isDynamicSeats(extractSeats(nextAll)))
  } else {
    api.updateScene({
      elements: nextAll,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY // 用户可以用撤销去掉 agent 画的这一批
    })
  }
  showElements(api, [...fresh, ...markerElements, ...ghostElements], Boolean(proposalId))
  return { sceneJson: (await snapshot(api, false, hidden)).sceneJson }
}
