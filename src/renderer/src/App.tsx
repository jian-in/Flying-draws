import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  exportToBlob,
  MainMenu,
  newElementWith,
  serializeAsJSON
} from '@excalidraw/excalidraw'
import { exitPoint, type ShapeBox } from '../../main/geometry'
import type { DrawPlan, PendingChanges } from '../../main/ops'
import '@excalidraw/excalidraw/index.css'

type ExcalidrawProps = ComponentProps<typeof Excalidraw>
type OnChange = NonNullable<ExcalidrawProps['onChange']>
type SceneArgs = Parameters<OnChange>
type Api = Parameters<NonNullable<ExcalidrawProps['excalidrawAPI']>>[0]

const SAVE_DELAY_MS = 600
const EXPORT_MAX_SIZE = 1600

// 每个元素被改动时 version 会加一（删除也算），求和就能判断画面内容有没有变。
// 光标移动、缩放这类只改 appState 的操作不会触发保存。
function elementsVersion(elements: SceneArgs[0]): number {
  let sum = 0
  for (const el of elements) sum += el.version
  return sum + elements.length
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

type HiddenMap = Map<string, { opacity: number; locked: boolean }>
type AuthorFilter = 'all' | 'user' | 'agent' | 'other' | `seat:${string}`

interface SeatEntry {
  name: string
  color: string
  explicit: boolean
}

function extractSeats(elements: readonly SceneEl[]): { seats: SeatEntry[]; hasAnonAgent: boolean } {
  const map = new Map<string, SeatEntry>()
  let hasAnonAgent = false
  for (const el of elements) {
    if (el.isDeleted) continue
    const mark = el.customData?.flyingdraws
    if (mark?.role === 'marker' || mark?.author !== 'agent') continue
    if (typeof mark.agent === 'string' && mark.agent) {
      const existing = map.get(mark.agent)
      const color = typeof mark.color === 'string' && mark.color ? mark.color : (el.strokeColor || AGENT_COLOR)
      const explicit = Boolean(mark.seat)
      if (!existing) map.set(mark.agent, { name: mark.agent, color, explicit })
      else if (explicit && !existing.explicit) map.set(mark.agent, { ...existing, explicit: true, color })
    } else {
      hasAnonAgent = true
    }
  }
  return { seats: [...map.values()], hasAnonAgent }
}

const isDynamicSeats = (info: { seats: SeatEntry[]; hasAnonAgent: boolean }): boolean =>
  info.seats.some((s) => s.explicit) || info.seats.length >= 2

const seatsKeyOf = (info: { seats: SeatEntry[]; hasAnonAgent: boolean }): string =>
  `${info.seats.map((s) => `${s.name}:${s.color}:${s.explicit ? 1 : 0}`).join('|')}#${info.hasAnonAgent ? 1 : 0}`

function unmaskElements(elements: readonly SceneEl[], hidden: HiddenMap): SceneEl[] {
  if (!hidden.size) return elements as SceneEl[]
  return elements.map((el) => {
    const saved = hidden.get(el.id)
    if (!saved) return el
    // 读快照和存盘时把筛选隐藏掉的元素还原，不动 version，避免污染画板文件
    return { ...el, opacity: saved.opacity, locked: saved.locked }
  })
}

// 从画布当前状态取一份快照：场景 JSON，以及可选的 PNG 截图
// 用户当前看得见、又没被我们的界面挡住的那块画布（画布坐标）。agent 画新内容时优先往这里放。
// 四边按屏幕像素让出工具栏、横幅和底部筛选栏的位置。
const VIEW_INSET = { top: 130, right: 24, bottom: 80, left: 24 }
function visibleArea(appState: { scrollX: number; scrollY: number; width: number; height: number; zoom: { value: number } }): ViewBox | null {
  const z = appState.zoom?.value || 1
  const w = (appState.width - VIEW_INSET.left - VIEW_INSET.right) / z
  const h = (appState.height - VIEW_INSET.top - VIEW_INSET.bottom) / z
  if (!(w > 0 && h > 0)) return null
  return { x: -appState.scrollX + VIEW_INSET.left / z, y: -appState.scrollY + VIEW_INSET.top / z, w, h }
}
type ViewBox = { x: number; y: number; w: number; h: number }

async function snapshot(
  api: Api,
  withImage: boolean,
  hidden?: HiddenMap
): Promise<{ sceneJson: string; pngBase64: string | null; view: ViewBox | null }> {
  const raw = api.getSceneElements()
  const elements = hidden ? unmaskElements(raw, hidden) : raw
  const appState = api.getAppState()
  const files = api.getFiles()
  const sceneJson = serializeAsJSON(elements, appState, files, 'local')
  let pngBase64: string | null = null
  if (withImage && elements.length > 0) {
    const blob = await exportToBlob({
      elements,
      appState: { ...appState, exportBackground: true, exportWithDarkMode: false },
      files,
      mimeType: 'image/png',
      maxWidthOrHeight: EXPORT_MAX_SIZE,
      exportPadding: 24
    })
    pngBase64 = await blobToBase64(blob)
  }
  return { sceneJson, pngBase64, view: visibleArea(appState) }
}

// 画布默认是淡黄的纸色。用户自己换过背景色的画板不动，只把还是默认白底的换掉。
const PAPER_COLOR = '#fffbe6'
const paperOr = (color: unknown): string =>
  typeof color === 'string' && color && color.toLowerCase() !== '#ffffff' ? color : PAPER_COLOR

const USER_BUSY_WAIT_MS = 8000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 用户是不是正在画一笔、拖东西或打字。这时候往画布里写东西会打断手上的动作。
function userIsBusy(api: Api): boolean {
  const s = api.getAppState()
  return Boolean(
    s.newElement ||
      s.multiElement ||
      s.editingTextElement ||
      s.resizingElement ||
      s.selectionElement ||
      s.selectedElementsAreBeingDragged ||
      s.isResizing ||
      s.isRotating
  )
}

type SkeletonList = NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>
type SceneElementList = ReturnType<Api['getSceneElementsIncludingDeleted']>
type SceneEl = SceneElementList[number]

const BANNER_HEIGHT = 190 // 确认横幅大约占画布顶部这么高（屏幕像素）

// 把视野移到一批元素上，不改缩放。belowBanner 为 true 时把内容往下让一让，别被顶部的横幅挡住。
function showElements(api: Api, elements: readonly SceneEl[], belowBanner: boolean): void {
  if (!elements.length) return
  const minX = Math.min(...elements.map((el) => Math.min(el.x, el.x + el.width)))
  const maxX = Math.max(...elements.map((el) => Math.max(el.x, el.x + el.width)))
  const minY = Math.min(...elements.map((el) => Math.min(el.y, el.y + el.height)))
  const maxY = Math.max(...elements.map((el) => Math.max(el.y, el.y + el.height)))
  const s = api.getAppState()
  const zoom = s.zoom.value
  // 新内容本来就全在用户眼前（而且没被横幅挡住）就别动视野：画面突然一跳比不动更打扰人
  const seen = visibleArea(s)
  if (seen) {
    const top = belowBanner ? -s.scrollY + (BANNER_HEIGHT + 20) / zoom : seen.y
    if (minX >= seen.x && maxX <= seen.x + seen.w && minY >= top && maxY <= seen.y + seen.h) return
  }
  if (!belowBanner) {
    api.scrollToContent(elements, { fitToContent: false, animate: true })
    return
  }
  // 自己算滚动位置：把内容放在横幅下面那块区域的正中间；内容比那块区域还高时，顶部对齐到横幅下沿
  const room = s.height - BANNER_HEIGHT
  const top = (maxY - minY) * zoom > room - 40 ? BANNER_HEIGHT + 20 : BANNER_HEIGHT + (room - (maxY - minY) * zoom) / 2
  api.updateScene({
    appState: {
      scrollX: s.width / 2 / zoom - (minX + maxX) / 2,
      scrollY: top / zoom - minY
    }
  })
}

// agent 画的东西一律用蓝色，和用户画的区分开。还没确认的提议再加上虚线和半透明。
const AGENT_COLOR = '#1971c2'
const PROPOSAL_OPACITY = 55

// 这里要读写的字段比 Excalidraw 的联合类型好写得多，统一按这个形状看待元素
type Loose = SceneEl & {
  containerId?: string | null
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
  points?: readonly (readonly [number, number])[]
  fillStyle?: string
}
const patch = (el: SceneEl, changes: Record<string, unknown>): SceneEl =>
  newElementWith(el, changes as Parameters<typeof newElementWith>[1]) as SceneEl

function primaryAgentOf(elements: readonly SceneEl[], preferred: string | null): string | null {
  if (preferred) return preferred
  for (const el of elements) {
    if (el.isDeleted) continue
    const a = el.customData?.flyingdraws?.agent
    if (typeof a === 'string' && a) return a
  }
  return null
}

function matchesFilter(
  el: SceneEl,
  byId: Map<string, SceneEl>,
  filter: AuthorFilter,
  primaryAgent: string | null,
  dynamicSeats: boolean
): boolean {
  if (filter === 'all') return true
  const loose = el as Loose
  const host = loose.type === 'text' && loose.containerId ? (byId.get(loose.containerId) ?? el) : el
  const mark = host.customData?.flyingdraws
  if (filter === 'user') return mark?.author !== 'agent'
  if (mark?.author !== 'agent') return false
  if (filter.startsWith('seat:')) return mark.agent === filter.slice(5)
  if (dynamicSeats && filter === 'agent') return !(typeof mark.agent === 'string' && mark.agent)
  const name = typeof mark.agent === 'string' && mark.agent ? mark.agent : null
  const bucket = !name || !primaryAgent || name === primaryAgent ? 'agent' : 'other'
  return bucket === filter
}

function applyAuthorFilter(api: Api, nextFilter: AuthorFilter, hidden: HiddenMap, preferredAgent: string | null, dynamicSeats: boolean): void {
  const raw = api.getSceneElementsIncludingDeleted()
  const restored = unmaskElements(raw, hidden)
  hidden.clear()

  let finalElements = restored
  if (nextFilter !== 'all') {
    const byId = new Map(restored.map((el) => [el.id, el]))
    const primary = primaryAgentOf(restored, preferredAgent)
    finalElements = restored.map((el) => {
      if (el.isDeleted) return el
      if (matchesFilter(el, byId, nextFilter, primary, dynamicSeats)) return el
      hidden.set(el.id, { opacity: el.opacity ?? 100, locked: Boolean(el.locked) })
      // 不改 el.version：筛选显示不触发自动保存和版本号变化
      return { ...el, opacity: 0, locked: true, versionNonce: Math.floor(Math.random() * 1e9) }
    })
  }
  api.updateScene({
    elements: finalElements,
    captureUpdate: CaptureUpdateAction.NEVER
  })
}

// 执行计划里的样式修改、改字、独立文字修改和删除。
// 删节点时，绑在上面的文字和连着它的 agent 连线一起删；用户画的连线留着，只把那一头松开。
function applyChanges(elements: SceneEl[], plan: Pick<DrawPlan, 'updates' | 'textEdits' | 'styles' | 'deletes'>): SceneEl[] {
  if (!plan.updates.length && !plan.textEdits.length && !plan.styles.length && !plan.deletes.length) return elements
  const byId = new Map(elements.map((el) => [el.id, el]))
  const gone = new Set(plan.deletes)
  const goneNodes = new Set(plan.deletes.filter((id) => byId.get(id)?.type !== 'arrow'))
  for (const el of elements as Loose[]) {
    if (el.isDeleted || el.type !== 'arrow' || el.customData?.flyingdraws?.author !== 'agent') continue
    if ((el.startBinding && goneNodes.has(el.startBinding.elementId)) || (el.endBinding && goneNodes.has(el.endBinding.elementId))) gone.add(el.id)
  }

  const replaced = new Map<string, SceneEl>()
  const added: SceneEl[] = []
  const reshapedNodes = new Map<string, ShapeBox>()
  const styledById = new Map(plan.styles.map((s) => [s.elementId, s]))

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
    if (['rectangle', 'ellipse', 'diamond'].includes(nextType) && (s.shape || resized)) {
      reshapedNodes.set(target.id, { x: newX, y: newY, w: newW, h: newH, shape: nextType })
    }
  }

  // 2. 节点/连线改字或节点改形后的文字重排：不直接改旧文字，让 Excalidraw 重新算尺寸并替换
  for (const u of plan.updates) {
    const target = (replaced.get(u.elementId) ?? byId.get(u.elementId)) as Loose | undefined
    if (!target || target.isDeleted || gone.has(target.id)) continue
    const old = (elements as Loose[]).find((el) => !el.isDeleted && el.type === 'text' && el.containerId === target.id)
    if (old) gone.add(old.id)
    let bound = (target.boundElements ?? []).filter((b) => b.id !== old?.id)
    const grow: Record<string, unknown> = {}
    if (u.label) {
      const shape = { type: target.type, id: 'sl_tmp', x: target.x, y: target.y, width: target.width, height: target.height, label: { text: u.label } }
      const skeleton = target.type === 'arrow' ? { ...shape, points: target.points } : shape
      const made = convertToExcalidrawElements([skeleton] as unknown as SkeletonList, { regenerateIds: false })
      const text = made.find((el) => el.type === 'text')
      const box = made.find((el) => el.type !== 'text')
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
      // 显式指定了高度的重排不再自动撑高；其余情况新文字放不下时节点长高
      const explicitHeight = u.relayout && styledById.get(target.id)?.h !== undefined
      if (target.type !== 'arrow' && !explicitHeight && box && box.height > target.height) {
        grow.height = box.height
        if (reshapedNodes.has(target.id)) {
          const prev = reshapedNodes.get(target.id)!
          reshapedNodes.set(target.id, { ...prev, h: box.height })
        }
      }
    }
    replaced.set(target.id, patch(target, { ...grow, boundElements: bound }))
  }

  // 3. 修改独立文字的内容并重算宽高
  for (const te of plan.textEdits) {
    const target = (replaced.get(te.elementId) ?? byId.get(te.elementId)) as Loose | undefined
    if (!target || target.isDeleted || gone.has(target.id)) continue
    const made = convertToExcalidrawElements(
      [{ type: 'text', id: 'sl_tmp', x: target.x, y: target.y, text: te.text }] as unknown as SkeletonList,
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

  // 4. 节点改了形状或尺寸时，把连着它的箭头端点贴回到新轮廓上
  if (reshapedNodes.size > 0) {
    const nodeBox = (id: string): ShapeBox | null => {
      const reshaped = reshapedNodes.get(id)
      if (reshaped) return reshaped
      const el = (replaced.get(id) ?? byId.get(id)) as Loose | undefined
      if (!el || el.isDeleted) return null
      return { x: el.x, y: el.y, w: el.width, h: el.height, shape: el.type }
    }
    for (const original of elements as Loose[]) {
      if (original.isDeleted || gone.has(original.id) || original.type !== 'arrow') continue
      const el = (replaced.get(original.id) ?? original) as Loose
      const fromId = el.startBinding?.elementId
      const toId = el.endBinding?.elementId
      if ((!fromId || !reshapedNodes.has(fromId)) && (!toId || !reshapedNodes.has(toId))) continue
      const fromBox = fromId ? nodeBox(fromId) : null
      const toBox = toId ? nodeBox(toId) : null
      if (!fromBox && !toBox) continue
      const pts = (el.points && el.points.length >= 2 ? el.points : [[0, 0], [el.width, el.height]]).map(
        ([px, py]): [number, number] => [el.x + px, el.y + py]
      )
      const firstTarget = pts.length > 2 ? pts[1] : toBox ? [toBox.x + toBox.w / 2, toBox.y + toBox.h / 2] : pts[pts.length - 1]
      const lastTarget = pts.length > 2 ? pts[pts.length - 2] : fromBox ? [fromBox.x + fromBox.w / 2, fromBox.y + fromBox.h / 2] : pts[0]
      const nextStart = fromBox && reshapedNodes.has(fromId!) ? exitPoint(fromBox, firstTarget[0], firstTarget[1], 8) : pts[0]
      const nextEnd = toBox && reshapedNodes.has(toId!) ? exitPoint(toBox, lastTarget[0], lastTarget[1], 8) : pts[pts.length - 1]
      const absPts: [number, number][] = [nextStart, ...pts.slice(1, -1), nextEnd]
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
          points: relPts
        })
      )
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

// 把主进程排好的绘图计划画到画布上。
// proposalId 不为空时画在提议层上，等用户确认。
async function applyPlan(
  api: Api,
  plan: DrawPlan,
  proposalId: string | null,
  agent: string | null,
  seat: boolean,
  color: string | null,
  hidden: HiddenMap,
  filter: AuthorFilter,
  preferredAgent: string | null,
  dynamicSeats: boolean
): Promise<{ sceneJson: string }> {
  // 用户优先：等用户手上的动作做完（design.md 12.4）
  const deadline = Date.now() + USER_BUSY_WAIT_MS
  while (userIsBusy(api)) {
    if (Date.now() > deadline) throw new Error('the user is in the middle of drawing; wait a moment and call canvas_draw again')
    await sleep(100)
  }

  const current = unmaskElements(api.getSceneElementsIncludingDeleted(), hidden)
  const alive = new Set(current.filter((el) => !el.isDeleted).map((el) => el.id))
  for (const ref of plan.existingRefs) {
    if (!alive.has(ref)) throw new Error('a node these ops refer to was just deleted by the user; call canvas_read and try again')
  }

  const skeletons = [
    ...plan.nodes.map((n) => ({
      type: n.shape,
      id: n.elementId,
      x: n.x,
      y: n.y,
      width: n.w,
      height: n.h,
      ...(n.label ? { label: { text: n.label } } : {})
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
    ...plan.texts.map((t) => ({ type: 'text' as const, id: t.elementId, x: t.x, y: t.y, text: t.text }))
  ] as unknown as SkeletonList
  const created = skeletons.length ? convertToExcalidrawElements(skeletons, { regenerateIds: false }) : []

  // 标上"agent 画的"和席位信息，并把箭头两端绑到节点上（这样用户拖节点时箭头会跟着走）
  const edgeById = new Map(plan.edges.map((e) => [e.elementId, e]))
  const arrowsOn = new Map<string, { id: string; type: 'arrow' }[]>()
  const attach = (nodeId: string, arrowId: string) => {
    arrowsOn.set(nodeId, [...(arrowsOn.get(nodeId) ?? []), { id: arrowId, type: 'arrow' }])
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
  const fresh = created.map((el) => {
    const tagged = { ...el, ...look, customData: { ...el.customData, flyingdraws: mark } }
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

  const withArrows = (el: SceneEl): SceneEl => {
    const add = arrowsOn.get(el.id)
    if (!add) return el
    return newElementWith(el, { boundElements: [...(el.boundElements ?? []), ...add] })
  }

  const nextAll = [...applyChanges(current.map(withArrows), plan), ...fresh.map(withArrows), ...markerElements]
  api.updateScene({
    elements: nextAll,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY // 用户可以用撤销去掉 agent 画的这一批
  })
  if (filter !== 'all') applyAuthorFilter(api, filter, hidden, preferredAgent, dynamicSeats || seat || Boolean(agent))
  showElements(api, [...fresh, ...markerElements], Boolean(proposalId))
  return { sceneJson: (await snapshot(api, false, hidden)).sceneJson }
}

// 用户对一个提议做了决定。接受：提议层上的元素变成正式内容（实线、不透明，仍是对应席位颜色），
// 并把提议里尚未被用户删掉标记框的改动真正执行；拒绝：全部删掉。返回用户删掉标记框取消的改动说明。
function resolveProposal(api: Api, proposalId: string, accept: boolean, pending: PendingChanges | null, hidden: HiddenMap): string[] {
  const all = unmaskElements(api.getSceneElementsIncludingDeleted(), hidden)
  const liveIds = new Set(all.filter((el) => !el.isDeleted).map((el) => el.id))
  const skipped: string[] = []
  let working = all
  if (accept && pending) {
    const approvedTargets = new Set<string>()
    for (const m of pending.markers ?? []) {
      if (liveIds.has(m.frameId)) {
        for (const t of m.targets) approvedTargets.add(t)
      } else {
        skipped.push(`不同意${m.summary}`)
      }
    }
    working = applyChanges(all, {
      updates: (pending.updates ?? []).filter((u) => approvedTargets.has(u.elementId)),
      textEdits: (pending.textEdits ?? []).filter((t) => approvedTargets.has(t.elementId)),
      styles: (pending.styles ?? []).filter((s) => approvedTargets.has(s.elementId)),
      deletes: (pending.deletes ?? []).filter((id) => approvedTargets.has(id))
    })
  }

  const isProposed = (el: SceneEl): boolean => {
    const mark = el.customData?.flyingdraws
    return !el.isDeleted && mark?.layer === 'proposal' && mark?.proposal === proposalId
  }
  const isMarkerEl = (el: SceneEl): boolean => el.customData?.flyingdraws?.role === 'marker'
  const removed = new Set(working.filter((el) => isProposed(el) && (!accept || isMarkerEl(el))).map((el) => el.id))
  const elements = working.map((el) => {
    if (isProposed(el)) {
      if (!accept || isMarkerEl(el)) return newElementWith(el, { isDeleted: true })
      const prevMark = el.customData?.flyingdraws
      return newElementWith(el, {
        opacity: 100,
        strokeStyle: 'solid',
        customData: {
          ...el.customData,
          flyingdraws: {
            author: 'agent',
            ...(typeof prevMark?.agent === 'string' && prevMark.agent ? { agent: prevMark.agent } : {}),
            ...(prevMark?.seat ? { seat: true } : {}),
            ...(typeof prevMark?.color === 'string' && prevMark.color ? { color: prevMark.color } : {}),
            layer: 'final'
          }
        }
      })
    }
    // 删掉提议里的箭头后，把别的节点上"有箭头连着我"的记录也清掉
    if (removed.size && el.boundElements?.some((b) => removed.has(b.id))) {
      return newElementWith(el, { boundElements: el.boundElements.filter((b) => !removed.has(b.id)) })
    }
    return el
  })
  api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
  return skipped
}

type Status =
  | { kind: 'loading' }
  | { kind: 'idle' }
  | { kind: 'saved'; path: string; version: number; savedAt: string }
  | { kind: 'error'; message: string }

export default function App() {
  const [api, setApi] = useState<Api | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [boardInfo, setBoardInfo] = useState<{ board: string; title: string | null }>({ board: 'default', title: null })
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [hub, setHub] = useState<HubState>({ pending: [], agentWaiting: false, waitingAgents: [], inbox: 0, inboxTargets: [], handoff: null })
  const [toast, setToast] = useState<string | null>(null)
  const [filter, setFilter] = useState<AuthorFilter>('all')
  const [seatInfo, setSeatInfo] = useState<{ seats: SeatEntry[]; hasAnonAgent: boolean }>({ seats: [], hasAnonAgent: false })
  const filterRef = useRef<AuthorFilter>('all')
  const hiddenStateRef = useRef<HiddenMap>(new Map())
  const primaryAgentRef = useRef<string | null>(null)
  const lastSeatsKeyRef = useRef<string>('')
  const seatInfoRef = useRef(seatInfo)
  seatInfoRef.current = seatInfo
  const hubRef = useRef(hub)
  hubRef.current = hub

  // 几秒后自动消失的提示
  useEffect(() => {
    if (!toast) return
    // 字多的提示（比如告诉用户去哪里粘贴）多留一会儿，够读完
    const t = setTimeout(() => setToast(null), Math.min(8000, Math.max(3000, 1500 + toast.length * 150)))
    return () => clearTimeout(t)
  }, [toast])

  // 收件箱里的画被 agent 取走、或者画笔被接手：告诉用户一声
  const lastInbox = useRef(0)
  useEffect(() => {
    if (hub.inbox < lastInbox.current) setToast('agent 已经取走你的画')
    lastInbox.current = hub.inbox
  }, [hub.inbox])
  const hadHandoff = useRef(false)
  useEffect(() => {
    if (hadHandoff.current && !hub.handoff && !hub.inbox) setToast('画笔已被接手')
    hadHandoff.current = Boolean(hub.handoff)
  }, [hub.handoff, hub.inbox])
  useEffect(() => {
    if (!filter.startsWith('seat:')) return
    const seatName = filter.slice(5)
    if (!seatInfo.seats.some((s) => s.name === seatName) && apiRef.current) {
      filterRef.current = 'all'
      setFilter('all')
      applyAuthorFilter(apiRef.current, 'all', hiddenStateRef.current, primaryAgentRef.current, isDynamicSeats(seatInfo))
    }
  }, [seatInfo, filter])
  const [composing, setComposing] = useState(false)
  const [dock, setDock] = useState<DockState>({ docked: false, side: null, title: null }) // 画布窗口贴在哪个窗口旁边
  useEffect(() => {
    void window.flyingdraws.getDockState().then(setDock)
    return window.flyingdraws.onDockState(setDock)
  }, [])
  const [sendTo, setSendTo] = useState<string | null>(null) // 「发给 agent」时点选的席位，null 是所有 agent
  const [initialData] = useState(() =>
    window.flyingdraws.loadBoard().then((res) => {
      setBoardInfo({ board: res.board, title: res.title })
      setBoards(res.boards)
      setStatus(res.json ? { kind: 'saved', path: res.path, version: res.version, savedAt: new Date().toISOString() } : { kind: 'idle' })
      const scene = res.json ? (JSON.parse(res.json) as { elements?: SceneEl[]; appState?: Record<string, unknown> }) : {}
      const info = extractSeats(scene.elements ?? [])
      lastSeatsKeyRef.current = seatsKeyOf(info)
      setSeatInfo(info)
      return { ...scene, appState: { ...scene.appState, viewBackgroundColor: paperOr(scene.appState?.viewBackgroundColor) } }
    })
  )

  const latest = useRef<SceneArgs | null>(null)
  const lastSavedVersion = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const apiRef = useRef<Api | null>(null)
  apiRef.current = api

  const applyLoadedScene = useCallback(
    (
      currentApi: Api,
      res: {
        board: string
        title: string | null
        version: number
        json: string | null
        path?: string
        boards?: BoardSummary[]
        hubState?: HubState
      }
    ) => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
      const parsed = res.json ? (JSON.parse(res.json) as { elements?: SceneEl[]; appState?: Record<string, unknown>; files?: Record<string, unknown> }) : null
      const nextElements = parsed?.elements ?? []
      lastSavedVersion.current = elementsVersion(nextElements)
      latest.current = null
      hiddenStateRef.current.clear()
      filterRef.current = 'all'
      setFilter('all')
      const nextSeatInfo = extractSeats(nextElements)
      lastSeatsKeyRef.current = seatsKeyOf(nextSeatInfo)
      setSeatInfo(nextSeatInfo)
      currentApi.resetScene()
      if (parsed?.files && Object.keys(parsed.files).length > 0) {
        currentApi.addFiles(Object.values(parsed.files) as Parameters<Api['addFiles']>[0])
      }
      const nextAppState: Record<string, unknown> = { ...parsed?.appState }
      delete nextAppState.collaborators
      nextAppState.viewBackgroundColor = paperOr(nextAppState.viewBackgroundColor)
      currentApi.updateScene({
        elements: nextElements,
        appState: nextAppState as unknown as Parameters<Api['updateScene']>[0]['appState'],
        captureUpdate: CaptureUpdateAction.NEVER
      })
      currentApi.history.clear()
      setBoardInfo({ board: res.board, title: res.title })
      if (res.boards) setBoards(res.boards)
      else void window.flyingdraws.listBoards().then((list) => setBoards(list.boards))
      if (res.hubState) {
        lastInbox.current = res.hubState.inbox
        hadHandoff.current = Boolean(res.hubState.handoff)
        setHub(res.hubState)
      }
      setComposing(false)
      setStatus(
        res.json && res.path
          ? { kind: 'saved', path: res.path, version: res.version, savedAt: new Date().toISOString() }
          : { kind: 'idle' }
      )
    },
    []
  )

  const save = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const scene = latest.current
    if (!scene) return
    const [elements, appState, files] = scene
    try {
      const json = serializeAsJSON(unmaskElements(elements, hiddenStateRef.current), appState, files, 'local')
      const res = await window.flyingdraws.saveBoard(json)
      lastSavedVersion.current = elementsVersion(elements)
      setStatus({ kind: 'saved', path: res.path, version: res.version, savedAt: res.savedAt })
    } catch (err) {
      setStatus({ kind: 'error', message: String(err) })
    }
  }, [])

  const onChange = useCallback<OnChange>(
    (elements, appState, files) => {
      // 横幅和弹窗画在 Excalidraw 外面，要自己跟着它的深浅色走
      if (document.documentElement.dataset.fdTheme !== appState.theme) {
        document.documentElement.dataset.fdTheme = appState.theme
        window.flyingdraws.setTheme(appState.theme === 'dark' ? 'dark' : 'light')
      }
      latest.current = [elements, appState, files]
      const nextSeatInfo = extractSeats(elements)
      const nextSeatsKey = seatsKeyOf(nextSeatInfo)
      if (nextSeatsKey !== lastSeatsKeyRef.current) {
        lastSeatsKeyRef.current = nextSeatsKey
        setSeatInfo(nextSeatInfo)
      }
      const version = elementsVersion(elements)
      if (lastSavedVersion.current === null) {
        // 第一次回调是载入已有画板，记下版本，不重复保存
        lastSavedVersion.current = version
        return
      }
      if (version === lastSavedVersion.current) return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void save(), SAVE_DELAY_MS)
    },
    [save]
  )

  // 关窗口前把还没落盘的修改补存一次
  useEffect(() => {
    const flush = () => {
      if (timer.current) void save()
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [save])

  // 订阅 agent 请求的状态
  useEffect(() => {
    const off = window.flyingdraws.onHubState(setHub)
    void window.flyingdraws.getHubState().then(setHub)
    return off
  }, [])

  // 处理主进程发来的调用。画布 API 准备好以后才通知主进程"页面就绪"
  useEffect(() => {
    if (!api) return
    const off = window.flyingdraws.onRpc(async ({ id, method, params }) => {
      const current = apiRef.current
      try {
        if (!current) throw new Error('canvas is not ready')
        if (method === 'snapshot') {
          const withImage = Boolean((params as { image?: boolean })?.image)
          window.flyingdraws.rpcReply(id, await snapshot(current, withImage, hiddenStateRef.current))
        } else if (method === 'applyPlan') {
          const { plan, proposalId, agent, seat, color } = params as {
            plan: DrawPlan
            proposalId: string | null
            agent?: string | null
            seat?: boolean
            color?: string | null
          }
          const agentName = typeof agent === 'string' && agent.trim() ? agent.trim() : null
          if (agentName) primaryAgentRef.current = agentName
          window.flyingdraws.rpcReply(
            id,
            await applyPlan(
              current,
              plan,
              proposalId,
              agentName,
              Boolean(seat),
              color ?? null,
              hiddenStateRef.current,
              filterRef.current,
              primaryAgentRef.current,
              isDynamicSeats(seatInfoRef.current)
            )
          )
        } else if (method === 'loadScene') {
          const next = params as { board: string; title: string | null; version: number; json: string | null }
          applyLoadedScene(current, next)
          window.flyingdraws.rpcReply(id, { ok: true })
        } else if (method === 'syncBoards') {
          const next = params as {
            board: string
            title: string | null
            version: number
            boards: BoardSummary[]
            hubState: HubState
          }
          setBoardInfo({ board: next.board, title: next.title })
          setBoards(next.boards)
          lastInbox.current = next.hubState.inbox
          setHub(next.hubState)
          setStatus((prev) =>
            prev.kind === 'saved' ? { ...prev, version: next.version, savedAt: new Date().toISOString() } : prev
          )
          window.flyingdraws.rpcReply(id, { ok: true })
        } else {
          throw new Error(`unknown method ${method}`)
        }
      } catch (err) {
        window.flyingdraws.rpcReply(id, null, err instanceof Error ? err.message : String(err))
      }
    })
    window.flyingdraws.ready()
    return off
  }, [api, applyLoadedScene])

  const handleSwitchBoard = useCallback(
    async (targetBoard: string) => {
      const current = apiRef.current
      if (!current || targetBoard === boardInfo.board) return
      try {
        const snap = await snapshot(current, false, hiddenStateRef.current)
        const res = await window.flyingdraws.switchBoard({ board: targetBoard, currentSceneJson: snap.sceneJson })
        applyLoadedScene(current, res)
      } catch (err) {
        setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    },
    [applyLoadedScene, boardInfo.board]
  )

  const handleCreateBoard = useCallback(
    async (rawName: string) => {
      const current = apiRef.current
      if (!current) return
      const trimmed = rawName.trim()
      const snap = await snapshot(current, false, hiddenStateRef.current)
      const res = await window.flyingdraws.createBoard({
        name: trimmed,
        title: /\s/.test(trimmed) ? trimmed : undefined,
        currentSceneJson: snap.sceneJson
      })
      applyLoadedScene(current, res)
      setCreating(false)
      setToast(`已新建画板「${res.board}」`)
    },
    [applyLoadedScene]
  )

  const handleRenameBoard = useCallback(async (rawName: string) => {
    const current = apiRef.current
    if (!current) return
    const trimmed = rawName.trim()
    const snap = await snapshot(current, false, hiddenStateRef.current)
    const res = await window.flyingdraws.renameBoard({
      board: boardInfo.board,
      name: trimmed,
      title: /\s/.test(trimmed) ? trimmed : null,
      currentSceneJson: snap.sceneJson
    })
    setBoardInfo({ board: res.board, title: res.title })
    setBoards(res.boards)
    if (res.hubState) {
      lastInbox.current = res.hubState.inbox
      setHub(res.hubState)
    }
    setStatus({ kind: 'saved', path: res.path, version: res.version, savedAt: new Date().toISOString() })
    setRenaming(false)
    setToast(`已重命名画板为「${res.board}」`)
  }, [boardInfo.board])

  const handleDeleteBoard = useCallback(async () => {
    const current = apiRef.current
    if (!current) return
    const snap = await snapshot(current, false, hiddenStateRef.current)
    const target = boardInfo.board
    const res = await window.flyingdraws.deleteBoard({
      board: target,
      currentSceneJson: snap.sceneJson
    })
    applyLoadedScene(current, res)
    setConfirmDelete(false)
    setToast(`已删除画板「${res.deleted ?? target}」`)
  }, [applyLoadedScene, boardInfo.board])

  const submit = useCallback(
    async (requestId: string | null, note: string, to: string | null = null) => {
      if (!apiRef.current) return
      const snap = await snapshot(apiRef.current, true, hiddenStateRef.current)
      // 有 agent 正等着（或者这是在回应它的请求）时，画会直接交到它手上；否则先放进收件箱，
      // 主进程同时把一句取画的话放进剪贴板
      const res = await window.flyingdraws.submit({ requestId, note, to, ...snap })
      if (res.delivered) setToast(`${to ?? 'agent'} 已经收到你的画`)
      else if (res.hint) setToast(`已复制一句话，去${to ? `「${to}」的` : ''}聊天里粘贴，它就会来取`)
      lastSavedVersion.current = elementsVersion(apiRef.current.getSceneElements())
      setComposing(false)
    },
    []
  )

  // 回应 agent 的提议：先把提议层上的元素合并或删掉，再把结果发给 agent
  const decide = useCallback(async (requestId: string, proposalId: string, accept: boolean, note: string, pending?: unknown) => {
    const current = apiRef.current
    if (!current) return
    const skipped = resolveProposal(current, proposalId, accept, (pending as PendingChanges | null | undefined) ?? null, hiddenStateRef.current)
    if (filterRef.current !== 'all') {
      applyAuthorFilter(current, filterRef.current, hiddenStateRef.current, primaryAgentRef.current, isDynamicSeats(seatInfoRef.current))
    }
    const snap = await snapshot(current, true, hiddenStateRef.current)
    await window.flyingdraws.submit({ requestId, note, decision: accept ? 'accepted' : 'rejected', skipped, ...snap })
    lastSavedVersion.current = elementsVersion(current.getSceneElements())
  }, [])

  const selectFilter = useCallback((next: AuthorFilter) => {
    const target: AuthorFilter = next !== 'all' && filterRef.current === next ? 'all' : next
    filterRef.current = target
    setFilter(target)
    if (apiRef.current) {
      applyAuthorFilter(apiRef.current, target, hiddenStateRef.current, primaryAgentRef.current, isDynamicSeats(seatInfoRef.current))
    }
  }, [])

  // Ctrl+Shift+Enter：打开「发给 agent」；已经打开就直接发出去。
  // agent 的请求或提议正挂着时不替用户表态，只把光标放进那个横幅的附言框。
  const composingRef = useRef(composing)
  composingRef.current = composing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !e.shiftKey || !(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      e.stopPropagation()
      if (hubRef.current.pending.length) {
        document.querySelector<HTMLInputElement>('.fd-banner-note')?.focus()
      } else if (composingRef.current) {
        document.querySelector<HTMLButtonElement>('.fd-banner .fd-banner-actions .fd-primary')?.click()
      } else {
        setComposing(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // 请求按先来后到一个一个处理，横幅上写明后面还排着几个
  const request = hub.pending[0] ?? null
  const queued = Math.max(0, hub.pending.length - 1)

  // 轮到一个提议时，把视野移到它上面：画布上可能同时有好几个提议，要让用户知道现在问的是哪一个
  const requestId = request?.id ?? null
  const proposalId = request?.kind === 'proposal' ? request.proposalId : null
  useEffect(() => {
    if (!api || !proposalId) return
    // 应用刚启动时画板可能还没载入完，等提议的元素出现了再移
    let tries = 0
    const timer = setInterval(() => {
      const mine = api.getSceneElements().filter((el) => el.customData?.flyingdraws?.proposal === proposalId)
      if (!mine.length && ++tries < 20) return
      clearInterval(timer)
      showElements(api, mine, true)
    }, 250)
    return () => clearInterval(timer)
  }, [api, requestId, proposalId])

  // 端到端测试要直接操作画布（模拟用户拖动、改字），只在隔离的测试实例上开放
  useEffect(() => {
    if (api && window.flyingdraws.testMode) (window as unknown as { __flyingdrawsApi?: Api }).__flyingdrawsApi = api
  }, [api])

  const nextBoardName = () => {
    const used = new Set(boards.map((b) => b.board))
    for (let i = 1; ; i++) {
      const candidate = `board-${i}`
      if (!used.has(candidate)) return candidate
    }
  }

  const onlineSeats = hub.onlineSeats ?? []
  // 点选的席位中途离场了就退回「所有 agent」
  const sendTarget = sendTo && onlineSeats.some((s) => s.name === sendTo) ? sendTo : null
  const sendTargetWaiting = sendTarget ? onlineSeats.some((s) => s.name === sendTarget && s.waiting) : hub.agentWaiting
  const sendTargetName = sendTarget ?? 'agent'

  return (
    <>
      {/* 自己画的标题栏：和画布一个颜色，整条可以拖动窗口 */}
      <div className="fd-titlebar">
        <span className="fd-titlebar-app">Flying draws</span>
        {/* 画板切换、新建、「⋯」菜单和保存状态都在标题栏里，画布右上角只留「发给 agent」 */}
        <div className="fd-status fd-titlebar-tools">
          <select
            className="fd-board-select"
            aria-label="切换画板"
            title="切换当前画板"
            value={boardInfo.board}
            onChange={(e) => void handleSwitchBoard(e.target.value)}
          >
            {boards.some((b) => b.board === boardInfo.board) ? null : (
              <option value={boardInfo.board}>{boardInfo.title || boardInfo.board}</option>
            )}
            {boards.map((b) => (
              <option key={b.board} value={b.board}>
                {b.title ? `${b.title} (${b.board})` : b.board}
              </option>
            ))}
          </select>
          <button
            className="fd-icon fd-new-board"
            onClick={() => setCreating(true)}
            aria-label="新建画板"
            title="新建一块空白画板"
          >
            +
          </button>
          <MoreMenu
            items={[
              { label: '重命名', title: '重命名当前画板', onSelect: () => setRenaming(true) },
              { label: '立即保存', title: '立即把当前画布写入文件', onSelect: () => void save() },
              {
                label: '打开文件位置',
                title: '在资源管理器中显示画板文件',
                onSelect: () => void window.flyingdraws.revealBoard()
              },
              {
                label: '重新加载',
                title: '重新载入页面（没存盘的修改会先保存）',
                sepBefore: true,
                onSelect: () => void save().then(() => window.flyingdraws.reloadWindow())
              },
              { label: '开发者工具', title: '打开或关闭开发者工具', onSelect: () => window.flyingdraws.toggleDevTools() },
              {
                sepBefore: true,
                label: '删除',
                title: boards.length <= 1 ? '至少保留一块画板' : '删除当前画板',
                danger: true,
                disabled: boards.length <= 1,
                onSelect: () => setConfirmDelete(true)
              }
            ]}
          />
          <StatusText status={status} />
          {dock.docked ? (
            <button
              type="button"
              className="fd-dock-pill"
              title={`画布贴在「${dock.title ?? '另一个窗口'}」${dock.side === 'left' ? '左' : '右'}边，会跟着它移动和缩放。点一下解除，或者直接把画布拖开`}
              onClick={() => window.flyingdraws.releaseDock()}
            >
              已吸附 ×
            </button>
          ) : null}
        </div>
        <div className="fd-seats" aria-label="在线 agent 席位">
          {onlineSeats.length ? (
            <>
              <span className="fd-seats-label">在线</span>
              {onlineSeats.map((s) => {
                const canFilter = s.drawn && isDynamicSeats(seatInfo) && seatInfo.seats.some((item) => item.name === s.name)
                const active = canFilter && filter === `seat:${s.name}`
                const title = [
                  `席位：${s.name}`,
                  s.waiting ? '正在等待你的画' : '已接入',
                  canFilter ? '点击筛选该席位元素' : s.drawn ? '当前画板已落笔' : '当前画板尚未落笔'
                ].join(' · ')
                return (
                  <button
                    key={s.name}
                    type="button"
                    className={`fd-seat-pill${s.waiting ? ' fd-seat-pill-waiting' : ''}${active ? ' fd-seat-pill-active' : ''}`}
                    title={title}
                    disabled={!canFilter}
                    onClick={() => canFilter && selectFilter(`seat:${s.name}`)}
                  >
                    <span className="fd-seat-dot" style={{ background: s.color }} />
                    <span className="fd-seat-name">{s.name}</span>
                    {s.waiting ? <span className="fd-seat-badge">等待中</span> : null}
                  </button>
                )
              })}
            </>
          ) : (
            <span className="fd-seats-empty">暂无 agent 接入</span>
          )}
        </div>
      </div>
      <div className={`fd-canvas${request || composing || hub.agentWaiting || hub.handoff || hub.inbox > 0 ? ' fd-has-notice' : ''}`}>
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData}
        onChange={onChange}
        langCode="zh-CN"
        renderTopRightUI={() => (
          <div className="fd-status">
            <button className="fd-primary" onClick={() => setComposing(true)} title="把当前画布发给 agent（Ctrl+Shift+Enter）">
              发给 agent
            </button>
          </div>
        )}
      >
        <MainMenu>
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.DefaultItems.SaveToActiveFile />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
      </div>
      {creating ? (
        <BoardNameModal
          modeTitle="新建画板"
          submitLabel="创建"
          busyLabel="创建中…"
          defaultName={nextBoardName()}
          onSubmit={handleCreateBoard}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {renaming ? (
        <BoardNameModal
          modeTitle="重命名画板"
          submitLabel="保存"
          busyLabel="保存中…"
          defaultName={boardInfo.title ?? boardInfo.board}
          onSubmit={handleRenameBoard}
          onClose={() => setRenaming(false)}
        />
      ) : null}
      {confirmDelete ? (
        <ConfirmModal
          title="删除画板"
          message={`确定要删除画板「${boardInfo.title ? `${boardInfo.title} (${boardInfo.board})` : boardInfo.board}」吗？文件会从磁盘移除，无法恢复。`}
          confirmLabel="确认删除"
          busyLabel="删除中…"
          onConfirm={handleDeleteBoard}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
      {request && request.kind === 'proposal' && request.proposalId ? (
        <Banner
          key={request.id}
          title="agent 画了它的理解（蓝色虚线部分），可以直接在上面改："
          prompt={request.prompt}
          queued={queued}
          onSend={(note) => decide(request.id, request.proposalId!, true, note, request.pending)}
          sendLabel="对，就这样"
          onCancel={(note) => decide(request.id, request.proposalId!, false, note, request.pending)}
          cancelLabel="不对，去掉"
        />
      ) : request ? (
        <Banner
          key={request.id}
          title="agent 请你画："
          prompt={request.prompt}
          queued={queued}
          onSend={(note) => submit(request.id, note)}
          onCancel={() => void window.flyingdraws.cancel(request.id)}
          cancelLabel="不画了"
        />
      ) : composing ? (
        <Banner
          title="把当前画布发给 agent"
          prompt={
            sendTargetWaiting
              ? `${sendTargetName} 正在等你的画，发出后它马上就能看到。`
              : `${sendTargetName} 现在没在等。发出后会复制一句话到剪贴板，去它的聊天里粘贴一下，它才会来取。`
          }
          onSend={(note) => submit(null, note, sendTarget)}
          onCancel={() => setComposing(false)}
          cancelLabel="取消"
          keyboard
        >
          {/* 只有一个 agent 时不用选；两个以上才问发给谁 */}
          {onlineSeats.length > 1 ? (
            <div className="fd-send-to" role="radiogroup" aria-label="发给谁">
              <button type="button" role="radio" aria-checked={!sendTarget} className={!sendTarget ? 'fd-send-to-active' : undefined} onClick={() => setSendTo(null)}>
                所有 agent
              </button>
              {onlineSeats.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  role="radio"
                  aria-checked={sendTarget === s.name}
                  className={sendTarget === s.name ? 'fd-send-to-active' : undefined}
                  title={s.waiting ? '正在等你的画' : '没在等，发出后要去它的聊天里说一声'}
                  onClick={() => setSendTo(s.name)}
                >
                  <span className="fd-seat-dot" style={{ background: s.color }} />
                  {`@${s.name}`}
                  {s.waiting ? <span className="fd-seat-badge">等待中</span> : null}
                </button>
              ))}
            </div>
          ) : null}
        </Banner>
      ) : hub.agentWaiting ? (
        <div className="fd-waiting fd-waiting-live">
          agent 正在等你{hub.waitingAgents?.length ? `（${hub.waitingAgents.join('、')}）` : ''}：画好后点右上角「发给 agent」
        </div>
      ) : hub.handoff ? (
        <div className="fd-waiting">
          {hub.handoff.from} 把画笔递给了 {hub.handoff.to ?? '其他席位'}：「{hub.handoff.note}」
        </div>
      ) : hub.inbox > 0 ? (
        <div className="fd-waiting">
          已发出{hub.inbox > 1 ? ` ${hub.inbox} 份` : ''}，{hub.inboxTargets?.length ? hub.inboxTargets.join('、') : 'agent'} 还没来取。在聊天里跟它说一声「画好了」
          <button
            type="button"
            className="fd-waiting-action"
            title="把那句取画的话再复制一次，粘贴到 agent 的聊天里"
            onClick={() => void window.flyingdraws.copyHint().then((hint) => hint && setToast('已复制，去聊天里粘贴'))}
          >
            复制这句话
          </button>
        </div>
      ) : null}
      {toast ? (
        <button type="button" className="fd-toast" role="status" title="点一下收起" onClick={() => setToast(null)}>
          {toast}
        </button>
      ) : null}
      <div className="fd-filter" role="tablist" aria-label="按作者筛选显示">
        {isDynamicSeats(seatInfo) ? (
          <>
            <button role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'fd-filter-active' : undefined} onClick={() => selectFilter('all')}>
              全部
            </button>
            <button role="tab" aria-selected={filter === 'user'} className={filter === 'user' ? 'fd-filter-active' : undefined} onClick={() => selectFilter('user')}>
              我画的
            </button>
            {seatInfo.seats.map((s) => {
              const key: AuthorFilter = `seat:${s.name}`
              return (
                <button
                  key={s.name}
                  role="tab"
                  aria-selected={filter === key}
                  className={filter === key ? 'fd-filter-active' : undefined}
                  onClick={() => selectFilter(key)}
                >
                  <span className="fd-seat-dot" style={{ background: s.color }} />
                  {s.name}
                </button>
              )
            })}
            {seatInfo.hasAnonAgent ? (
              <button
                role="tab"
                aria-selected={filter === 'agent'}
                className={filter === 'agent' ? 'fd-filter-active' : undefined}
                onClick={() => selectFilter('agent')}
              >
                agent 画的
              </button>
            ) : null}
          </>
        ) : (
          (
            [
              ['all', '全部'],
              ['user', '我画的'],
              ['agent', 'agent 画的'],
              ['other', '其他 agent']
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={filter === key}
              className={filter === key ? 'fd-filter-active' : undefined}
              onClick={() => selectFilter(key)}
            >
              {label}
            </button>
          ))
        )}
      </div>
    </>
  )
}

function BoardNameModal(props: {
  modeTitle: string
  submitLabel: string
  busyLabel: string
  defaultName: string
  onSubmit: (name: string) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(props.defaultName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (!name.trim()) {
      setError('画板名称不能为空')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await props.onSubmit(name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }
  return (
    <div className="fd-modal-backdrop" onClick={() => !busy && props.onClose()}>
      <div className="fd-modal" role="dialog" aria-label={props.modeTitle} onClick={(e) => e.stopPropagation()}>
        <div className="fd-modal-title">{props.modeTitle}</div>
        <input
          autoFocus
          value={name}
          placeholder="例如：login-flow 或 登录流程"
          onFocus={(e) => e.target.select()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !busy) void submit()
            if (e.key === 'Escape' && !busy) props.onClose()
          }}
        />
        {error ? <div className="fd-error">{error}</div> : null}
        <div className="fd-modal-actions">
          <button onClick={props.onClose} disabled={busy}>
            取消
          </button>
          <button className="fd-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? props.busyLabel : props.submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function ConfirmModal(props: {
  title: string
  message: string
  confirmLabel: string
  busyLabel: string
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await props.onConfirm()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }
  return (
    <div className="fd-modal-backdrop" onClick={() => !busy && props.onClose()}>
      <div
        className="fd-modal"
        role="dialog"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' && !busy) props.onClose()
        }}
      >
        <div className="fd-modal-title">{props.title}</div>
        <div>{props.message}</div>
        {error ? <div className="fd-error">{error}</div> : null}
        <div className="fd-modal-actions">
          <button autoFocus onClick={props.onClose} disabled={busy}>
            取消
          </button>
          <button className="fd-danger" onClick={() => void confirm()} disabled={busy}>
            {busy ? props.busyLabel : props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function Banner(props: {
  title: string
  prompt: string
  queued?: number // 这个请求后面还排着几个
  onSend: (note: string) => Promise<void>
  sendLabel?: string
  onCancel: (note: string) => void | Promise<void>
  cancelLabel: string
  children?: ReactNode // 提示语和附言之间的额外内容，比如点选发给哪个席位
  keyboard?: boolean // 用户自己打开的横幅：一出来就把光标放进附言框，Enter 发送、Esc 取消
}) {
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: (note: string) => void | Promise<void>) => {
    setSending(true)
    setError(null)
    try {
      await action(note)
    } catch (err) {
      setError(String(err))
      setSending(false)
    }
  }
  const send = () => run(props.onSend)
  return (
    <div
      className="fd-banner"
      role="dialog"
      aria-label={props.title}
      onKeyDown={(e) => {
        if (props.keyboard && e.key === 'Escape' && !sending) {
          e.stopPropagation()
          void run(props.onCancel)
        }
      }}
    >
      <div className="fd-banner-title">{props.title}</div>
      <div className="fd-banner-prompt">{props.prompt}</div>
      {props.queued ? <div className="fd-banner-queued">处理完这个，后面还有 {props.queued} 个请求</div> : null}
      {props.children}
      <input
        className="fd-banner-note"
        placeholder={props.keyboard ? '想补充一句话吗？（可不填，Enter 发送，Esc 取消）' : '想补充一句话吗？（可不填）'}
        autoFocus={props.keyboard}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation() // 别让 Excalidraw 把输入当成快捷键
          if (e.key === 'Enter' && !sending) void send()
          // 上面拦住了冒泡，横幅外层收不到这次按键，Esc 要在这里自己处理
          else if (e.key === 'Escape' && props.keyboard && !sending) void run(props.onCancel)
        }}
      />
      {error ? <div className="fd-error">{error}</div> : null}
      <div className="fd-banner-actions">
        <button onClick={() => void run(props.onCancel)} disabled={sending}>
          {props.cancelLabel}
        </button>
        <button className="fd-primary" onClick={() => void send()} disabled={sending}>
          {sending ? '发送中…' : (props.sendLabel ?? '发送')}
        </button>
      </div>
    </div>
  )
}

type MenuItem = { label: string; title?: string; danger?: boolean; disabled?: boolean; sepBefore?: boolean; onSelect: () => void }

// 右上角的「⋯」菜单：不常用的画板操作收在这里，免得和 Excalidraw 的工具栏抢位置
function MoreMenu({ items }: { items: MenuItem[] }) {
  // 菜单挂到 body 上（不然会被横幅盖住），位置按按钮算：右边对齐，贴在按钮下面
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const open = pos !== null
  const setOpen = (next: boolean | ((v: boolean) => boolean)) =>
    setPos((prev) => {
      const want = typeof next === 'function' ? next(prev !== null) : next
      const rect = wrap.current?.getBoundingClientRect()
      return want && rect ? { top: rect.bottom + 6, right: window.innerWidth - rect.right } : null
    })
  const wrap = useRef<HTMLDivElement | null>(null)
  const menu = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (!wrap.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    const onResize = () => setOpen(false)
    window.addEventListener('resize', onResize)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  return (
    <div className="fd-more-wrap" ref={wrap}>
      <button
        className="fd-icon fd-more"
        aria-label="更多画板操作"
        aria-haspopup="menu"
        aria-expanded={open}
        title="更多"
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {pos
        ? createPortal(
            <div className="fd-menu" role="menu" ref={menu} style={{ top: pos.top, right: pos.right }}>
              {items.flatMap((item) => [
                item.sepBefore ? <div key={`${item.label}-sep`} className="fd-menu-sep" role="separator" /> : null,
                <button
                  key={item.label}
                  role="menuitem"
                  className={item.danger ? 'fd-menu-danger' : undefined}
                  title={item.title}
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false)
                    item.onSelect()
                  }}
                >
                  {item.label}
                </button>
              ])}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

// 保存状态：一个小圆点加两三个字，细节（版本号、时间、路径）放在悬停提示里
function StatusText({ status }: { status: Status }) {
  switch (status.kind) {
    case 'loading':
      return <span className="fd-save">载入中…</span>
    case 'idle':
      return <span className="fd-save">未修改</span>
    case 'saved':
      return (
        <span
          className="fd-save fd-save-ok"
          title={`v${status.version} · ${new Date(status.savedAt).toLocaleTimeString()}\n${status.path}`}
        >
          已保存
        </span>
      )
    case 'error':
      return (
        <span className="fd-save fd-save-error" title={status.message}>
          出错了：{status.message}
        </span>
      )
  }
}
