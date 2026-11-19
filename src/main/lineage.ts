// 多轮视觉演进墙排版与血缘提取（纯函数，零 Node 专属依赖，主进程与渲染进程共用）。
import { exitPoint, type ShapeBox } from './geometry.ts'
import {
  shouldAutoPlaceResultImage,
  type AgentResultImage,
  type AgentTool,
  type ImageRegionAnnotation,
  type ImageSourceMeta
} from '../shared/agent.ts'

export { shouldAutoPlaceResultImage }

export const LINEAGE_GAP_X = 160
export const LINEAGE_ROW_GAP_Y = 80
const CAPTION_OFFSET_Y = 28
const MAX_DISPLAY_WIDTH = 700
const MAX_DISPLAY_HEIGHT = 500

export interface LineageViewBox {
  x: number
  y: number
  w: number
  h: number
}

export interface LineageCanvasElement {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  isDeleted?: boolean
  points?: readonly (readonly [number, number])[]
  containerId?: string | null
  customData?: {
    flyingdraws?: {
      author?: string
      layer?: string
      agent?: string
      seat?: boolean
      role?: string
      result?: string
      lineageVersion?: number
      lineageRole?: string
      imageMeta?: ImageSourceMeta
    }
  } | null
}

export interface PlannedLineageEdge {
  id: string
  fromId: string
  toId: string
  x: number
  y: number
  points: [number, number][]
  label: string
}

export interface PlannedLineageCaption {
  id: string
  text: string
  x: number
  y: number
  fontSize: number
}

/** 改前圈选的区域投到改后截图上的位置（虚线框），方便对照着看。 */
export interface PlannedCompareOverlay {
  id: string
  x: number
  y: number
  w: number
  h: number
  label: string
}

export interface ImageLineagePlan {
  alreadyPlaced: boolean
  existingElementId: string | null
  imageId: string
  x: number
  y: number
  w: number
  h: number
  parentId: string | null
  versionNumber: number
  edge: PlannedLineageEdge | null
  caption: PlannedLineageCaption | null
  overlays: PlannedCompareOverlay[]
}

export interface PlanImageLineageInput {
  elements: readonly LineageCanvasElement[]
  image: AgentResultImage
  size?: { w: number; h: number }
  naturalSize?: { w: number; h: number }
  sourceImageRef?: string | null
  newImageId?: string
  view?: LineageViewBox | null
  /** 本轮在源图上的圈选；有父图时投到新图上 */
  annotations?: readonly ImageRegionAnnotation[]
}

const OVERLAY_MIN = 28

/**
 * 把源图（parentId）上的圈选按原图像素比例投到另一张图在画布上的显示框里。
 * 两张图宽高比差得多时（视口不一致），标签前加「≈」表示位置是近似的。
 */
export function mapAnnotationsToImage(
  annotations: readonly ImageRegionAnnotation[],
  parentId: string,
  box: LineageViewBox,
  targetNatural?: { w: number; h: number } | null
): Omit<PlannedCompareOverlay, 'id'>[] {
  const out: Omit<PlannedCompareOverlay, 'id'>[] = []
  for (const ann of annotations) {
    if (ann.imageRef !== parentId) continue
    const nw = ann.naturalSize?.w ?? 0
    const nh = ann.naturalSize?.h ?? 0
    if (!(nw > 0 && nh > 0)) continue
    const approx = Boolean(targetNatural && targetNatural.w > 0 && targetNatural.h > 0 && Math.abs(targetNatural.w / targetNatural.h - nw / nh) > 0.02 * (nw / nh))
    let x = box.x + (ann.pixelBbox.x / nw) * box.w
    let y = box.y + (ann.pixelBbox.y / nh) * box.h
    let w = (ann.pixelBbox.w / nw) * box.w
    let h = (ann.pixelBbox.h / nh) * box.h
    if (w < OVERLAY_MIN) { x -= (OVERLAY_MIN - w) / 2; w = OVERLAY_MIN }
    if (h < OVERLAY_MIN) { y -= (OVERLAY_MIN - h) / 2; h = OVERLAY_MIN }
    const x0 = Math.max(box.x, Math.min(x, box.x + box.w))
    const y0 = Math.max(box.y, Math.min(y, box.y + box.h))
    const x1 = Math.max(box.x, Math.min(x + w, box.x + box.w))
    const y1 = Math.max(box.y, Math.min(y + h, box.y + box.h))
    if (x1 - x0 < 2 || y1 - y0 < 2) continue
    out.push({ x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0), label: `${approx ? '≈' : ''}对照 #${out.length + 1}` })
  }
  return out
}

const FILE_EDIT_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch'])

function shortFileName(rawPath: string): string | null {
  const cleaned = rawPath.trim().replace(/^['"`]+|['"`]+$/g, '').trim()
  if (!cleaned || cleaned === '/dev/null' || cleaned === 'null') return null
  const parts = cleaned.split(/[\\/]+/).filter(Boolean)
  const base = parts.at(-1)?.trim() ?? ''
  if (!base || base === '.' || base === '..' || base.length > 80) return null
  if (/[\x00-\x1f]/.test(base)) return null
  return base
}

function extractPatchPaths(text: string): string[] {
  const paths: string[] = []
  for (const match of text.matchAll(/\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*([^\r\n*]+)/g)) {
    paths.push(match[1])
  }
  for (const match of text.matchAll(/\*\*\*\s+Move to:\s*([^\r\n*]+)/g)) {
    paths.push(match[1])
  }
  for (const match of text.matchAll(/^\+\+\+\s+(?:b\/)?([^\r\n\t]+)/gm)) {
    const candidate = match[1].trim()
    if (candidate !== '/dev/null' && candidate !== 'null') paths.push(candidate)
  }
  return paths
}

function extractPathsFromInput(input: string): string[] {
  if (!input || typeof input !== 'string') return []
  const trimmed = input.trim()
  if (!trimmed) return []
  const rawPaths: string[] = []

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      for (const key of ['path', 'file_path', 'filePath', 'file', 'target_file', 'filename']) {
        if (typeof parsed[key] === 'string') rawPaths.push(parsed[key] as string)
      }
      for (const listKey of ['files', 'edits', 'changes']) {
        const list = parsed[listKey]
        if (Array.isArray(list)) {
          for (const item of list) {
            if (typeof item === 'string') rawPaths.push(item)
            else if (item && typeof item === 'object') {
              const rec = item as Record<string, unknown>
              for (const key of ['path', 'file_path', 'filePath', 'file']) {
                if (typeof rec[key] === 'string') rawPaths.push(rec[key] as string)
              }
            }
          }
        }
      }
      for (const patchKey of ['patch', 'diff', 'content', 'input']) {
        if (typeof parsed[patchKey] === 'string' && (patchKey !== 'content' || rawPaths.length === 0)) {
          rawPaths.push(...extractPatchPaths(parsed[patchKey] as string))
        }
      }
    } catch {
      // params_preview 可能被截断，退回正则提取
    }
  }

  if (rawPaths.length === 0) {
    for (const match of trimmed.matchAll(/"(?:path|file_path|filePath|file|target_file|filename)"\s*:\s*"((?:\\.|[^"\\])+)"/g)) {
      rawPaths.push(match[1].replace(/\\\\/g, '\\').replace(/\\\//g, '/').replace(/\\"/g, '"'))
    }
    rawPaths.push(...extractPatchPaths(trimmed.replace(/\\n/g, '\n')))
  }

  if (rawPaths.length === 0) {
    for (const match of trimmed.matchAll(/(?:^|[\s,{])(?:path|file_path|filePath|file)\s*[:=]\s*([^\s,;}]+)/g)) {
      rawPaths.push(match[1])
    }
  }

  return rawPaths
}

/**
 * 从本轮成功完成的 `write_file` / `edit_file` / `apply_patch` 工具调用预览中提取去重后的短文件名（最多保留 `maxFiles` 个）。
 */
export function extractChangedFiles(
  tools: readonly Pick<AgentTool, 'name' | 'input' | 'status'>[],
  toolLabels?: Record<string, string>,
  maxFiles = 4
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tool of tools) {
    if (tool.status !== 'completed') continue
    const label = toolLabels?.[tool.name] ?? ''
    const remote = (label ? label.slice(label.lastIndexOf('/') + 1) : tool.name.slice(tool.name.lastIndexOf('/') + 1)).toLowerCase()
    if (!FILE_EDIT_TOOLS.has(remote)) continue
    for (const raw of extractPathsFromInput(tool.input)) {
      const name = shortFileName(raw)
      if (!name || seen.has(name)) continue
      seen.add(name)
      out.push(name)
      if (out.length >= maxFiles) return out
    }
  }
  return out
}

export function displaySizeForImage(naturalWidth: number, naturalHeight: number): { w: number; h: number } {
  const natW = naturalWidth > 0 ? naturalWidth : 640
  const natH = naturalHeight > 0 ? naturalHeight : 480
  const scale = Math.min(1, MAX_DISPLAY_WIDTH / natW, MAX_DISPLAY_HEIGHT / natH)
  return {
    w: Math.max(1, Math.round(natW * scale)),
    h: Math.max(1, Math.round(natH * scale))
  }
}

export function formatLineageEdgeLabel(meta?: ImageSourceMeta, fallbackRound = 2): string {
  // 轮次就是任务里的第几轮，和面板、语义层一致；只有没记录轮次的图才退回用版本号。
  // 不能取两者较大值：第 1 轮出的是 v2（v1 是用户放的原图），那样连线会比面板多一轮。
  const round = meta?.round && meta.round > 0 ? meta.round : fallbackRound
  const files = (meta?.changedFiles ?? []).map((f) => f.trim()).filter(Boolean).slice(0, 4)
  return files.length > 0 ? `第 ${round} 轮 · ${files.join(', ')}` : `第 ${round} 轮结果`
}

export function formatLineageCaption(versionNumber: number, naturalSize?: { w: number; h: number } | null): string {
  if (naturalSize && naturalSize.w > 0 && naturalSize.h > 0) {
    return `v${versionNumber} · ${Math.round(naturalSize.w)}×${Math.round(naturalSize.h)}`
  }
  return `v${versionNumber}`
}

function elementBounds(el: Pick<LineageCanvasElement, 'x' | 'y' | 'width' | 'height' | 'points'>): LineageViewBox {
  if (Array.isArray(el.points) && el.points.length >= 2) {
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const [px, py] of el.points) {
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
    }
    return { x: el.x + minX, y: el.y + minY, w: maxX - minX, h: maxY - minY }
  }
  const x = el.width < 0 ? el.x + el.width : el.x
  const y = el.height < 0 ? el.y + el.height : el.y
  return { x, y, w: Math.abs(el.width), h: Math.abs(el.height) }
}

function boxesOverlap(a: LineageViewBox, b: LineageViewBox, margin = 0): boolean {
  return (
    a.x < b.x + b.w + margin &&
    a.x + a.w + margin > b.x &&
    a.y < b.y + b.h + margin &&
    a.y + a.h + margin > b.y
  )
}

function findParentImage(
  liveImages: readonly LineageCanvasElement[],
  image: AgentResultImage,
  explicitSourceRef?: string | null
): LineageCanvasElement | null {
  const sourceRef = explicitSourceRef ?? image.meta?.sourceImageRef ?? null
  if (sourceRef) {
    const byId = liveImages.find((el) => el.id === sourceRef && el.customData?.flyingdraws?.result !== image.id)
    if (byId) return byId
  }

  const workItemId = image.meta?.workItemId
  if (!workItemId) return null

  const sameWorkItem = liveImages.filter(
    (el) =>
      el.customData?.flyingdraws?.imageMeta?.workItemId === workItemId &&
      el.customData?.flyingdraws?.result !== image.id
  )
  if (!sameWorkItem.length) return null

  const currentRound = image.meta?.round
  if (typeof currentRound === 'number') {
    const earlier = sameWorkItem.filter((el) => {
      const r = el.customData?.flyingdraws?.imageMeta?.round
      return typeof r === 'number' && r < currentRound
    })
    if (earlier.length > 0) {
      let best = earlier[0]
      let bestRound = best.customData?.flyingdraws?.imageMeta?.round ?? 0
      for (const cand of earlier.slice(1)) {
        const r = cand.customData?.flyingdraws?.imageMeta?.round ?? 0
        if (r >= bestRound) {
          best = cand
          bestRound = r
        }
      }
      return best
    }
    const notAfter = sameWorkItem.filter((el) => {
      const r = el.customData?.flyingdraws?.imageMeta?.round
      return r === undefined || r <= currentRound
    })
    return notAfter.at(-1) ?? null
  }

  return sameWorkItem.at(-1) ?? null
}

function placeBesideParent(
  parentBox: LineageViewBox,
  w: number,
  h: number,
  obstacles: readonly LineageViewBox[]
): { x: number; y: number } {
  const baseX = Math.round(parentBox.x + parentBox.w + LINEAGE_GAP_X)
  const baseY = Math.round(parentBox.y)
  const rowStepY = Math.max(parentBox.h, h) + LINEAGE_ROW_GAP_Y
  const stepX = 80
  const maxOffsetX = Math.max(240, Math.round(w * 0.5))

  for (let row = 0; row < 25; row += 1) {
    const cy = baseY + row * rowStepY
    for (let dx = 0; dx <= maxOffsetX; dx += stepX) {
      const cx = baseX + dx
      const slot = { x: cx, y: cy - CAPTION_OFFSET_Y, w, h: h + CAPTION_OFFSET_Y }
      if (!obstacles.some((o) => boxesOverlap(slot, o, 24))) {
        return { x: cx, y: cy }
      }
    }
  }

  const col = obstacles.filter((o) => o.x < baseX + w + 80 && o.x + o.w > baseX - 80)
  const bottom = col.length ? Math.max(...col.map((o) => o.y + o.h)) : baseY + parentBox.h
  return { x: baseX, y: Math.round(bottom + LINEAGE_ROW_GAP_Y) }
}

function placeInView(
  w: number,
  h: number,
  obstacles: readonly LineageViewBox[],
  view?: LineageViewBox | null
): { x: number; y: number } {
  let x = Math.round((view?.x ?? 20) + 20)
  let y = Math.round((view?.y ?? 20) + 20)
  if (view && w <= view.w && h <= view.h) {
    let found = false
    for (let cy = view.y; cy + h <= view.y + view.h && !found; cy += 40) {
      for (let cx = view.x; cx + w <= view.x + view.w; cx += 40) {
        const slot = { x: cx, y: cy, w, h }
        if (!obstacles.some((o) => boxesOverlap(slot, o, 24))) {
          x = Math.round(cx)
          y = Math.round(cy)
          found = true
          break
        }
      }
    }
    if (!found) {
      const col = obstacles.filter((o) => o.x < view.x + view.w && o.x + o.w > view.x)
      x = Math.round(view.x + 20)
      y = Math.round(col.length ? Math.max(...col.map((o) => o.y + o.h)) + 40 : view.y + 20)
    }
  } else if (obstacles.length) {
    const nearby = view
      ? obstacles.filter((o) => o.x < view.x + view.w + w && o.x + o.w > view.x - w)
      : obstacles
    const ref = nearby.length ? nearby : obstacles
    y = Math.round(Math.max(...ref.map((o) => o.y + o.h)) + 40)
  }
  return { x, y }
}

/**
 * 规划一张结果图片在画布上的落位与多轮演进关系（`parent.id → newImageId` 连线 + 版本题注）。
 */
export function planImageLineage(input: PlanImageLineageInput): ImageLineagePlan {
  const { elements, image, view } = input
  const live = elements.filter((el) => {
    if (el.isDeleted) return false
    const role = el.customData?.flyingdraws?.role
    return role !== 'marker' && role !== 'move-ghost'
  })
  const existing = live.find((el) => el.type === 'image' && el.customData?.flyingdraws?.result === image.id)
  if (existing) {
    const box = elementBounds(existing)
    return {
      alreadyPlaced: true,
      existingElementId: existing.id,
      imageId: existing.id,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      parentId: null,
      versionNumber: existing.customData?.flyingdraws?.lineageVersion ?? image.meta?.round ?? 1,
      edge: null,
      caption: null,
      overlays: []
    }
  }

  const natW = input.naturalSize?.w ?? image.meta?.naturalWidth ?? 0
  const natH = input.naturalSize?.h ?? image.meta?.naturalHeight ?? 0
  const computedSize = input.size ?? displaySizeForImage(natW > 0 ? natW : 640, natH > 0 ? natH : 480)
  const w = Math.max(1, Math.round(computedSize.w))
  const h = Math.max(1, Math.round(computedSize.h))

  const takenIds = new Set(elements.map((el) => el.id))
  const uniqueId = (base: string): string => {
    if (!takenIds.has(base)) {
      takenIds.add(base)
      return base
    }
    let idx = 2
    while (takenIds.has(`${base}_${idx}`)) idx += 1
    const next = `${base}_${idx}`
    takenIds.add(next)
    return next
  }

  const imageId = uniqueId(input.newImageId ?? `fd_img_${image.id.slice(0, 12)}`)
  const liveImages = live.filter((el) => el.type === 'image')
  const parent = findParentImage(liveImages, image, input.sourceImageRef)

  if (!parent) {
    const obstacles = live.map(elementBounds)
    const { x, y } = placeInView(w, h, obstacles, view)
    const versionNumber = image.meta?.round && image.meta.round > 0 ? image.meta.round : 1
    return {
      alreadyPlaced: false,
      existingElementId: null,
      imageId,
      x,
      y,
      w,
      h,
      parentId: null,
      versionNumber,
      edge: null,
      caption: null,
      overlays: []
    }
  }

  const parentBox = elementBounds(parent)
  const obstacles = live
    .filter((el) => el.id !== parent.id && el.containerId !== parent.id)
    .map(elementBounds)
  const { x, y } = placeBesideParent(parentBox, w, h, obstacles)

  const parentVer =
    parent.customData?.flyingdraws?.lineageVersion ??
    parent.customData?.flyingdraws?.imageMeta?.round ??
    1
  const versionNumber = Math.max(2, parentVer + 1)

  const fromShape: ShapeBox = { x: parentBox.x, y: parentBox.y, w: parentBox.w, h: parentBox.h, shape: 'rectangle' }
  const toShape: ShapeBox = { x, y, w, h, shape: 'rectangle' }
  const start = exitPoint(fromShape, x + w / 2, y + h / 2, 8)
  const end = exitPoint(toShape, parentBox.x + parentBox.w / 2, parentBox.y + parentBox.h / 2, 8)
  const sx = Math.round(start[0])
  const sy = Math.round(start[1])
  const dx = Math.round(end[0] - start[0])
  const dy = Math.round(end[1] - start[1])

  const edge: PlannedLineageEdge = {
    id: uniqueId(`${imageId}_edge`),
    fromId: parent.id,
    toId: imageId,
    x: sx,
    y: sy,
    points: [[0, 0], [dx, dy]],
    label: formatLineageEdgeLabel(image.meta, versionNumber)
  }

  const caption: PlannedLineageCaption = {
    id: uniqueId(`${imageId}_cap`),
    text: formatLineageCaption(versionNumber, natW > 0 && natH > 0 ? { w: natW, h: natH } : null),
    x,
    y: y - CAPTION_OFFSET_Y,
    fontSize: 16
  }

  return {
    alreadyPlaced: false,
    existingElementId: null,
    imageId,
    x,
    y,
    w,
    h,
    parentId: parent.id,
    versionNumber,
    edge,
    caption,
    overlays: mapAnnotationsToImage(input.annotations ?? [], parent.id, { x, y, w, h }, natW > 0 && natH > 0 ? { w: natW, h: natH } : null).map(
      (overlay, i) => ({ ...overlay, id: uniqueId(`${imageId}_cmp${i + 1}`) })
    )
  }
}
