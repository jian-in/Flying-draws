// 语义层 v1：把 Excalidraw 场景翻译成 agent 好读的结构和文字描述。
// 纯函数，不依赖 Electron，可以直接用 node --test 测试。
import { parseImageHeaderSize } from './imageSize.ts'
import type { ImageSourceMeta } from '../shared/agent.ts'

export interface Bbox {
  x: number
  y: number
  w: number
  h: number
}

export interface SceneFile {
  mimeType?: string
  dataURL?: string
}

export interface ImageCrop {
  x: number
  y: number
  width: number
  height: number
  naturalWidth?: number
  naturalHeight?: number
}

// 只列出语义层用到的字段，Excalidraw 元素的其他字段原样忽略
export interface SceneElement {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  angle?: number
  isDeleted?: boolean
  text?: string
  fileId?: string | null
  scale?: readonly [number, number]
  crop?: ImageCrop | null
  containerId?: string | null
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
  startArrowhead?: string | null
  endArrowhead?: string | null
  points?: readonly (readonly [number, number])[]
  groupIds?: readonly string[]
  frameId?: string | null
  name?: string | null
  customData?: {
    flyingdraws?: {
      author?: string
      layer?: string
      agent?: string
      seat?: boolean
      color?: string
      role?: string
      result?: string
      imageMeta?: ImageSourceMeta
    }
  } | null
}

export type Author = 'user' | 'agent'

// 元素是谁画的。agent 画的元素在 customData.flyingdraws.author 里有标记，其余都算用户画的。
export function authorOf(el: SceneElement): Author {
  return el.customData?.flyingdraws?.author === 'agent' ? 'agent' : 'user'
}

// 是哪个 agent 画的（桥接报上来的客户端名字）。用户画的、或者早先没记名字的 agent 元素都是 null。
export function agentOf(el: SceneElement): string | null {
  const name = el.customData?.flyingdraws?.agent
  return authorOf(el) === 'agent' && typeof name === 'string' && name ? name : null
}

// 提议里"要改这里"的标记框和说明文字：只是给用户看的示意，不算画板内容
export function isMarker(el: SceneElement): boolean {
  return el.customData?.flyingdraws?.role === 'marker'
}

// 作者，以及是不是还在提议层上（agent 画的提议，用户还没确认）
function provenance(el: SceneElement): { author: Author; agent: string | null; proposed: boolean } {
  return { author: authorOf(el), agent: agentOf(el), proposed: el.customData?.flyingdraws?.layer === 'proposal' }
}

export interface SemanticNode {
  id: string // 给 agent 看的短编号：N1、N2……
  ref: string // Excalidraw 元素 id
  kind: string
  label: string | null
  bbox: Bbox
  author: Author
  agent: string | null // 哪个 agent 画的；用户画的或没记名字时为 null
  proposed: boolean // true 表示这是 agent 的提议，用户还没确认
}

export interface SemanticEdge {
  ref: string
  from: string | null // 节点短编号；没连上任何节点时为 null
  to: string | null
  label: string | null
  directed: 'forward' | 'both' | 'none'
  inferred: boolean // true 表示箭头端点没有真正绑定，是按距离猜的
  author: Author
  agent: string | null
  proposed: boolean // true 表示这是 agent 的提议，用户还没确认
}

export interface SemanticNote {
  id: string // 给 agent 看的短编号：T1、T2……
  ref: string
  text: string
  attachedTo: { kind: 'node' | 'edge'; id: string } | null
  position: string | null // 相对位置，如"下方"
  bbox: Bbox
  author: Author
  agent: string | null
  proposed: boolean // true 表示这是 agent 的提议，用户还没确认
}

export interface SemanticStroke {
  id: string // 给 agent 看的短编号：S1、S2……和手绘分组共用一套编号，分组排在前面
  ref: string
  shape: 'loop' | 'straight' | 'curve'
  bbox: Bbox
  encloses: string[] // 被圈住的节点、文字、手绘分组或图片短编号
  near: { id: string; position: string } | null
  imageRegion?: { imageId: string; canvasBbox: Bbox; pixelBbox?: Bbox } | null
}

// 挨得近的几笔手绘合成一组（手写字、多笔涂鸦）。语义层不猜内容，只说在哪、有几笔，内容交给截图。
export interface SemanticStrokeGroup {
  id: string
  refs: string[]
  count: number
  bbox: Bbox
  near: { id: string; position: string } | null
  region: string | null // 没有节点可参照时，在整张画里的大致方位，如"右上角"
}

export interface SemanticImageAnnotation {
  kind: 'loop' | 'box' | 'arrow' | 'stroke_group' | 'text'
  by: string // S1 / N1 / T1 / 连线 ref
  canvasBbox: Bbox
  pixelBbox?: Bbox
  pixelPoint?: { x: number; y: number }
  note?: string | null
}

// 图片按出现顺序编号 I1、I2……，agent 用它把图里的内容转成可编辑元素（trace_image）或读取圈选的原图像素坐标
export interface SemanticImage {
  id: string
  ref: string
  bbox: Bbox
  naturalSize?: { w: number; h: number } | null
  meta?: ImageSourceMeta | null
  resultImageId?: string | null
  author: Author
  agent: string | null
  proposed: boolean
  annotations: SemanticImageAnnotation[]
}

export interface SemanticGraph {
  nodes: SemanticNode[]
  edges: SemanticEdge[]
  notes: SemanticNote[]
  strokes: SemanticStroke[] // 只含没被分组的单笔
  strokeGroups: SemanticStrokeGroup[]
  containment: { parent: string; child: string }[]
  images: SemanticImage[]
  lines: { ref: string; bbox: Bbox }[]
  needsImage: boolean // 有语义层看不懂的内容，建议 agent 看图
}

const SHAPE_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'frame', 'magicframe', 'embeddable', 'iframe'])
const KIND_NAMES: Record<string, string> = {
  rectangle: '矩形',
  ellipse: '椭圆',
  diamond: '菱形',
  frame: '框架',
  magicframe: '框架',
  embeddable: '嵌入块',
  iframe: '嵌入块',
  image: '图片',
  text: '文字'
}

const NOTE_ATTACH_DISTANCE = 150 // 游离文字离节点或连线多近算"旁注"
const DIAGONAL_PENALTY = 1.5 // 文字在节点斜对角时，距离按 1.5 倍算，优先挂到正对着的目标上
const MIN_STROKE_SIZE = 6 // 外接框对角线小于这个值的笔画当作误点，忽略
const MAX_LISTED_STROKES = 8 // 文字描述里最多逐条列出的手绘笔画数
const EDGE_SNAP_DISTANCE = 40 // 箭头端点没绑定时，离节点多近算连上
// 两笔手绘离多近算同一组：阈值取两笔里较小那笔的对角线长度，再夹到这个范围里。
// 跟着笔画大小走，画布缩放不同、字写得大小不同时都能用。
const GROUP_GAP_MIN = 30
const GROUP_GAP_MAX = 150
const GROUP_SAMPLE_POINTS = 24 // 算两笔之间的距离时，每笔最多取这么多个点

export function bboxOf(el: SceneElement): Bbox {
  // Excalidraw 的 freedraw / line / arrow 以起点为 (x, y)，往左或往上画时 points 含负坐标，而 width/height 仍为正数
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

/**
 * 把画布上的矩形区域换算成图片原始像素坐标系下的区域（兼容缩放、裁剪 crop 与翻转 scale）。
 * 若目标区域与图片不相交，返回 null。
 */
export function canvasRectToImagePixels(
  target: Bbox,
  imgBbox: Bbox,
  src: Bbox,
  scale?: readonly [number, number]
): Bbox | null {
  if (imgBbox.w <= 0 || imgBbox.h <= 0 || src.w <= 0 || src.h <= 0) return null
  const ix0 = Math.max(target.x, imgBbox.x)
  const iy0 = Math.max(target.y, imgBbox.y)
  const ix1 = Math.min(target.x + target.w, imgBbox.x + imgBbox.w)
  const iy1 = Math.min(target.y + target.h, imgBbox.y + imgBbox.h)
  if (ix1 <= ix0 || iy1 <= iy0) return null
  let u0 = (ix0 - imgBbox.x) / imgBbox.w
  let u1 = (ix1 - imgBbox.x) / imgBbox.w
  let v0 = (iy0 - imgBbox.y) / imgBbox.h
  let v1 = (iy1 - imgBbox.y) / imgBbox.h
  if (scale && scale[0] < 0) [u0, u1] = [1 - u1, 1 - u0]
  if (scale && scale[1] < 0) [v0, v1] = [1 - v1, 1 - v0]
  const x0 = Math.round(src.x + u0 * src.w)
  const y0 = Math.round(src.y + v0 * src.h)
  const x1 = Math.round(src.x + u1 * src.w)
  const y1 = Math.round(src.y + v1 * src.h)
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
}

export function canvasPointToImagePixels(
  px: number,
  py: number,
  imgBbox: Bbox,
  src: Bbox,
  scale?: readonly [number, number]
): { x: number; y: number } | null {
  if (imgBbox.w <= 0 || imgBbox.h <= 0 || src.w <= 0 || src.h <= 0) return null
  if (px < imgBbox.x || px > imgBbox.x + imgBbox.w || py < imgBbox.y || py > imgBbox.y + imgBbox.h) return null
  let u = (px - imgBbox.x) / imgBbox.w
  let v = (py - imgBbox.y) / imgBbox.h
  if (scale && scale[0] < 0) u = 1 - u
  if (scale && scale[1] < 0) v = 1 - v
  return {
    x: Math.min(src.x + src.w, Math.max(src.x, Math.round(src.x + u * src.w))),
    y: Math.min(src.y + src.h, Math.max(src.y, Math.round(src.y + v * src.h)))
  }
}

function intersectBbox(a: Bbox, b: Bbox): Bbox | null {
  const x0 = Math.max(a.x, b.x)
  const y0 = Math.max(a.y, b.y)
  const x1 = Math.min(a.x + a.w, b.x + b.w)
  const y1 = Math.min(a.y + a.h, b.y + b.h)
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
}

function center(b: Bbox): [number, number] {
  return [b.x + b.w / 2, b.y + b.h / 2]
}

function distToBbox(px: number, py: number, b: Bbox): number {
  const dx = Math.max(b.x - px, 0, px - (b.x + b.w))
  const dy = Math.max(b.y - py, 0, py - (b.y + b.h))
  return Math.hypot(dx, dy)
}

function bboxDistance(a: Bbox, b: Bbox): number {
  const dx = Math.max(b.x - (a.x + a.w), 0, a.x - (b.x + b.w))
  const dy = Math.max(b.y - (a.y + a.h), 0, a.y - (b.y + b.h))
  return Math.hypot(dx, dy)
}

function contains(outer: Bbox, inner: Bbox, slack = 2): boolean {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.w <= outer.x + outer.w + slack &&
    inner.y + inner.h <= outer.y + outer.h + slack
  )
}

// 目标相对于参照物的方位，用中文八方向描述
export function relativePosition(target: Bbox, ref: Bbox): string {
  if (contains(ref, target)) return '内部'
  const [tx, ty] = center(target)
  const left = ref.x
  const right = ref.x + ref.w
  const top = ref.y
  const bottom = ref.y + ref.h
  const horiz = tx < left ? '左' : tx > right ? '右' : ''
  const vert = ty < top ? '上' : ty > bottom ? '下' : ''
  if (horiz && vert) return `${horiz}${vert}方`
  if (horiz) return `${horiz}侧`
  if (vert) return `${vert}方`
  return '重叠处'
}

function absPoints(el: SceneElement): [number, number][] {
  return (el.points ?? []).map(([px, py]) => [el.x + px, el.y + py])
}

function classifyStroke(el: SceneElement): SemanticStroke['shape'] {
  const pts = absPoints(el)
  if (pts.length < 3) return 'straight'
  const [sx, sy] = pts[0]
  const [ex, ey] = pts[pts.length - 1]
  const b = bboxOf(el)
  const diag = Math.hypot(b.w, b.h) || 1
  // 首尾离得近，算一个圈
  if (Math.hypot(ex - sx, ey - sy) < diag * 0.2 && diag > 20) return 'loop'
  // 所有点离首尾连线都很近，算直线
  const len = Math.hypot(ex - sx, ey - sy) || 1
  let maxDev = 0
  for (const [px, py] of pts) {
    const dev = Math.abs((ey - sy) * px - (ex - sx) * py + ex * sy - ey * sx) / len
    if (dev > maxDev) maxDev = dev
  }
  return maxDev < len * 0.08 ? 'straight' : 'curve'
}

export function unionBbox(boxes: Bbox[]): Bbox {
  const x0 = Math.min(...boxes.map((b) => b.x))
  const y0 = Math.min(...boxes.map((b) => b.y))
  const x1 = Math.max(...boxes.map((b) => b.x + b.w))
  const y1 = Math.max(...boxes.map((b) => b.y + b.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

// 一笔里均匀抽出的若干个点。用点而不用外接框算距离，
// 这样一个大圈和圈里面的字不会因为外接框重叠被并成一组。
function strokeSamples(el: SceneElement): [number, number][] {
  const pts = absPoints(el)
  if (pts.length === 0) return [[el.x, el.y]]
  if (pts.length <= GROUP_SAMPLE_POINTS) return pts
  const out: [number, number][] = []
  for (let i = 0; i < GROUP_SAMPLE_POINTS; i++) {
    out.push(pts[Math.round((i * (pts.length - 1)) / (GROUP_SAMPLE_POINTS - 1))])
  }
  return out
}

function minPointDistance(a: [number, number][], b: [number, number][]): number {
  let best = Infinity
  for (const [ax, ay] of a) {
    for (const [bx, by] of b) {
      const d = Math.hypot(ax - bx, ay - by)
      if (d < best) best = d
    }
  }
  return best
}

// 一块内容在整张画里的大致方位。内容本身就占了大半张画时返回 null。
function canvasRegion(b: Bbox, overall: Bbox): string | null {
  if (b.w > overall.w * 0.6 && b.h > overall.h * 0.6) return null
  const [cx, cy] = center(b)
  const fx = overall.w > 0 ? (cx - overall.x) / overall.w : 0.5
  const fy = overall.h > 0 ? (cy - overall.y) / overall.h : 0.5
  const horiz = fx < 1 / 3 ? '左' : fx > 2 / 3 ? '右' : ''
  const vert = fy < 1 / 3 ? '上' : fy > 2 / 3 ? '下' : ''
  if (horiz && vert) return `${horiz}${vert}角`
  if (horiz) return `${horiz}侧`
  if (vert) return `${vert}方`
  return '中间'
}

// 阅读顺序：按左上角先分行（纵向容差 40px），再从左到右。
// 用左上角而不用中心，外框才会排在它里面的小框前面。
function readingOrder(a: Bbox, b: Bbox): number {
  if (Math.abs(a.y - b.y) > 40) return a.y - b.y
  return a.x - b.x
}

// 两个框在横向或纵向上有没有投影重叠。都不重叠说明是斜对角关系。
function projectionsOverlap(a: Bbox, b: Bbox): boolean {
  const xOverlap = a.x <= b.x + b.w && b.x <= a.x + a.w
  const yOverlap = a.y <= b.y + b.h && b.y <= a.y + a.h
  return xOverlap || yOverlap
}

// 沿折线每隔约 10px 取一个点，用来近似计算框到线的距离
function samplePolyline(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[i + 1]
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 10))
    for (let k = 0; k < n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n])
  }
  if (pts.length) out.push(pts[pts.length - 1])
  return out
}

function bboxToPolyline(b: Bbox, samples: [number, number][]): { d: number; at: [number, number] } {
  // 距离相同的点里，取离文字中心最近的那个，这样"正下方"不会被说成"右下方"
  const [cx, cy] = center(b)
  let d = Infinity
  let tie = Infinity
  let at: [number, number] = samples[0] ?? [0, 0]
  for (const p of samples) {
    const dd = distToBbox(p[0], p[1], b)
    const tt = Math.hypot(p[0] - cx, p[1] - cy)
    if (dd < d - 0.5 || (Math.abs(dd - d) <= 0.5 && tt < tie)) {
      d = Math.min(d, dd)
      tie = tt
      at = p
    }
  }
  return { d, at }
}

function resolveImageMeta(
  el: SceneElement,
  files?: Readonly<Record<string, SceneFile>> | null
): { naturalSize: { w: number; h: number } | null; meta: ImageSourceMeta | null; src: Bbox | null } {
  const meta = el.customData?.flyingdraws?.imageMeta ?? null
  let naturalSize: { w: number; h: number } | null = null
  if (meta && meta.naturalWidth > 0 && meta.naturalHeight > 0) {
    naturalSize = { w: Math.round(meta.naturalWidth), h: Math.round(meta.naturalHeight) }
  } else if (el.crop && el.crop.naturalWidth && el.crop.naturalHeight && el.crop.naturalWidth > 0 && el.crop.naturalHeight > 0) {
    naturalSize = { w: Math.round(el.crop.naturalWidth), h: Math.round(el.crop.naturalHeight) }
  } else if (el.fileId && files?.[el.fileId]?.dataURL) {
    naturalSize = parseImageHeaderSize(files[el.fileId]!.dataURL!)
  }
  const src: Bbox | null =
    el.crop && el.crop.width > 0 && el.crop.height > 0
      ? { x: el.crop.x, y: el.crop.y, w: el.crop.width, h: el.crop.height }
      : naturalSize
        ? { x: 0, y: 0, w: naturalSize.w, h: naturalSize.h }
        : null
  return { naturalSize, meta, src }
}

export function buildGraph(
  rawElements: readonly SceneElement[],
  files?: Readonly<Record<string, SceneFile>> | null
): SemanticGraph {
  const elements = rawElements.filter((el) => !el.isDeleted && !isMarker(el))
  const byId = new Map(elements.map((el) => [el.id, el]))

  // 绑定在容器里的文字 → 容器的标签
  const boundText = new Map<string, string>()
  const boundTextIds = new Set<string>()
  for (const el of elements) {
    if (el.type === 'text' && el.containerId && byId.has(el.containerId)) {
      boundText.set(el.containerId, (el.text ?? '').trim())
      boundTextIds.add(el.id)
    }
  }

  // 被箭头绑定的元素都算节点（包括被箭头连着的独立文字）
  const bindTargets = new Set<string>()
  for (const el of elements) {
    if (el.type !== 'arrow') continue
    if (el.startBinding) bindTargets.add(el.startBinding.elementId)
    if (el.endBinding) bindTargets.add(el.endBinding.elementId)
  }

  const nodeEls = elements.filter(
    (el) => SHAPE_TYPES.has(el.type) || (bindTargets.has(el.id) && !boundTextIds.has(el.id) && el.type !== 'arrow')
  )
  nodeEls.sort((a, b) => readingOrder(bboxOf(a), bboxOf(b)))

  const nodes: SemanticNode[] = nodeEls.map((el, i) => ({
    id: `N${i + 1}`,
    ref: el.id,
    kind: el.type,
    label: el.type === 'text' ? (el.text ?? '').trim() : (boundText.get(el.id) ?? el.name ?? null) || null,
    bbox: bboxOf(el),
    ...provenance(el)
  }))
  const nodeByRef = new Map(nodes.map((n) => [n.ref, n]))

  const nearestNode = (px: number, py: number): SemanticNode | null => {
    let best: SemanticNode | null = null
    let bestD = EDGE_SNAP_DISTANCE
    for (const n of nodes) {
      if (n.kind === 'frame' || n.kind === 'magicframe') continue
      const d = distToBbox(px, py, n.bbox)
      if (d <= bestD) {
        best = n
        bestD = d
      }
    }
    return best
  }

  // 连线
  const edges: SemanticEdge[] = []
  const edgeSamples = new Map<string, [number, number][]>()
  for (const el of elements) {
    if (el.type !== 'arrow') continue
    const pts = absPoints(el)
    const first = pts[0] ?? [el.x, el.y]
    const last = pts[pts.length - 1] ?? [el.x, el.y]
    let inferred = false
    let fromNode = el.startBinding ? (nodeByRef.get(el.startBinding.elementId) ?? null) : null
    let toNode = el.endBinding ? (nodeByRef.get(el.endBinding.elementId) ?? null) : null
    if (!fromNode) {
      fromNode = nearestNode(first[0], first[1])
      if (fromNode) inferred = true
    }
    if (!toNode) {
      toNode = nearestNode(last[0], last[1])
      if (toNode) inferred = true
    }
    const start = el.startArrowhead ?? null
    const end = el.endArrowhead ?? null
    let from = fromNode?.id ?? null
    let to = toNode?.id ?? null
    let directed: SemanticEdge['directed'] = 'forward'
    if (start && end) directed = 'both'
    else if (!start && !end) directed = 'none'
    else if (start && !end) [from, to] = [to, from] // 只有起点有箭头，方向反过来
    edges.push({ ref: el.id, from, to, label: boundText.get(el.id) ?? null, directed, inferred, ...provenance(el) })
    edgeSamples.set(el.id, samplePolyline(pts.length ? pts : [first, last]))
  }

  // 游离文字：挂到最近的节点或连线上，当旁注
  const notes: SemanticNote[] = []
  for (const el of elements) {
    if (el.type !== 'text' || boundTextIds.has(el.id) || nodeByRef.has(el.id)) continue
    const b = bboxOf(el)
    let best: SemanticNote['attachedTo'] = null
    let bestD = NOTE_ATTACH_DISTANCE
    let bestBox: Bbox | null = null
    for (const n of nodes) {
      if (n.kind === 'frame' || n.kind === 'magicframe') continue
      let d = bboxDistance(b, n.bbox)
      if (!projectionsOverlap(b, n.bbox)) d *= DIAGONAL_PENALTY
      if (d < bestD) {
        bestD = d
        best = { kind: 'node', id: n.id }
        bestBox = n.bbox
      }
    }
    for (const e of edges) {
      const { d, at } = bboxToPolyline(b, edgeSamples.get(e.ref)!)
      if (d < bestD) {
        bestD = d
        best = { kind: 'edge', id: e.ref }
        bestBox = { x: at[0] - 1, y: at[1] - 1, w: 2, h: 2 }
      }
    }
    notes.push({
      id: `T${notes.length + 1}`,
      ref: el.id,
      text: (el.text ?? '').trim(),
      attachedTo: best,
      position: bestBox ? relativePosition(b, bestBox) : null,
      bbox: b,
      ...provenance(el)
    })
  }

  const imageInfos = elements
    .filter((el) => el.type === 'image')
    .map((el, i) => {
      const bbox = bboxOf(el)
      const { naturalSize, meta, src } = resolveImageMeta(el, files)
      const image: SemanticImage = {
        id: `I${i + 1}`,
        ref: el.id,
        bbox,
        naturalSize,
        meta,
        resultImageId: el.customData?.flyingdraws?.result ?? null,
        ...provenance(el),
        annotations: []
      }
      return { el, image, src }
    })
  const images = imageInfos.map((x) => x.image)
  const lines = elements.filter((el) => el.type === 'line').map((el) => ({ ref: el.id, bbox: bboxOf(el) }))

  // 手绘笔画
  const nearestTo = (b: Bbox, skip: string[] = []): { id: string; position: string } | null => {
    let near: { id: string; position: string } | null = null
    let bestD = Infinity
    for (const n of nodes) {
      if (skip.includes(n.id) || n.kind === 'frame' || n.kind === 'magicframe') continue
      const d = bboxDistance(b, n.bbox)
      if (d < bestD) {
        bestD = d
        near = { id: n.id, position: relativePosition(b, n.bbox) }
      }
    }
    return near
  }

  // 先逐笔看一遍。这里先不丢掉很小的笔画：字里的点很小，但属于那个字。
  const raw = elements
    .filter((el) => el.type === 'freedraw')
    .map((el) => {
      const b = bboxOf(el)
      const diag = Math.hypot(b.w, b.h)
      const shape = classifyStroke(el)
      return { el, b, diag, shape, samples: strokeSamples(el) }
    })

  // 预判「标注圈」：圈住了节点、独立文字、整张图片，或圈住了更小的手绘笔画（如圈住一组手写字）。
  // 标注圈不参与手写分组，避免被并进里面的手写字变成一团涂鸦。
  const isAnnotationLoop = raw.map((s, idx) => {
    if (s.shape !== 'loop' || s.diag < 24) return false
    if (nodes.some((n) => contains(s.b, n.bbox, 8))) return true
    if (notes.some((n) => contains(s.b, n.bbox, 8))) return true
    if (images.some((img) => contains(s.b, img.bbox, 8))) return true
    if (
      raw.some(
        (other, j) =>
          j !== idx &&
          other.diag >= MIN_STROKE_SIZE &&
          other.diag < s.diag * 0.85 &&
          contains(s.b, other.b, 8)
      )
    ) {
      return true
    }
    return false
  })

  // 挨得近的笔画并成一组（并查集）。标注圈不参与分组；大圈也不并进旁边尺寸悬殊的小笔画。
  const parent = raw.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < raw.length; i++) {
    if (isAnnotationLoop[i]) continue
    for (let j = i + 1; j < raw.length; j++) {
      if (isAnnotationLoop[j]) continue
      if (
        (raw[i].shape === 'loop' && raw[i].diag >= 60 && raw[i].diag > raw[j].diag * 2.5) ||
        (raw[j].shape === 'loop' && raw[j].diag >= 60 && raw[j].diag > raw[i].diag * 2.5)
      ) {
        continue
      }
      const gap = Math.min(GROUP_GAP_MAX, Math.max(GROUP_GAP_MIN, Math.min(raw[i].diag, raw[j].diag)))
      if (bboxDistance(raw[i].b, raw[j].b) > gap) continue
      if (minPointDistance(raw[i].samples, raw[j].samples) <= gap) parent[find(i)] = find(j)
    }
  }
  const clusters = new Map<number, typeof raw>()
  raw.forEach((s, i) => {
    const root = find(i)
    if (!clusters.has(root)) clusters.set(root, [])
    clusters.get(root)!.push(s)
  })

  const strokeDrafts: { ref: string; shape: SemanticStroke['shape']; bbox: Bbox }[] = []
  const groupDrafts: { refs: string[]; bbox: Bbox }[] = []
  for (const members of clusters.values()) {
    // 整簇都是误点大小的，忽略
    if (members.every((s) => s.diag < MIN_STROKE_SIZE)) continue
    if (members.length === 1) {
      const s = members[0]
      strokeDrafts.push({ ref: s.el.id, shape: s.shape, bbox: s.b })
    } else {
      groupDrafts.push({ refs: members.map((s) => s.el.id), bbox: unionBbox(members.map((s) => s.b)) })
    }
  }
  groupDrafts.sort((a, b) => readingOrder(a.bbox, b.bbox))

  // 包含关系：框架里的元素，或一个形状完全套住另一个形状
  const containment: SemanticGraph['containment'] = []
  for (const child of nodes) {
    const el = byId.get(child.ref)!
    let parent: SemanticNode | null = null
    if (el.frameId) parent = nodeByRef.get(el.frameId) ?? null
    if (!parent) {
      for (const cand of nodes) {
        if (cand === child || cand.kind === 'text') continue
        if (cand.bbox.w * cand.bbox.h <= child.bbox.w * child.bbox.h) continue
        if (!contains(cand.bbox, child.bbox)) continue
        // 取面积最小的外框，作为直接父节点
        if (!parent || cand.bbox.w * cand.bbox.h < parent.bbox.w * parent.bbox.h) parent = cand
      }
    }
    if (parent) containment.push({ parent: parent.id, child: child.id })
  }

  // 手绘分组的方位：有节点就说在哪个节点旁边，没有节点就说在整张画的哪个位置
  const allBoxes = [
    ...nodes.map((n) => n.bbox),
    ...notes.map((n) => n.bbox),
    ...strokeDrafts.map((s) => s.bbox),
    ...groupDrafts.map((g) => g.bbox),
    ...images.map((i) => i.bbox),
    ...lines.map((l) => l.bbox)
  ]
  const overall = allBoxes.length ? unionBbox(allBoxes) : null
  const strokeGroups: SemanticStrokeGroup[] = groupDrafts.map((g, i) => {
    const near = nearestTo(g.bbox)
    return {
      id: `S${i + 1}`,
      refs: g.refs,
      count: g.refs.length,
      bbox: g.bbox,
      near,
      region: !near && overall ? canvasRegion(g.bbox, overall) : null
    }
  })

  // 单笔接着分组往下编号；现在分组和图片都已定好，计算圈住了谁（含节点、文字、手写组、单笔、图片）
  const numbered: SemanticStroke[] = strokeDrafts.map((s, i) => ({
    id: `S${strokeGroups.length + i + 1}`,
    ref: s.ref,
    shape: s.shape,
    bbox: s.bbox,
    encloses: [],
    near: null
  }))

  const nearestFreeNote = (target: Bbox, maxDist = 140): SemanticNote | null => {
    let best: SemanticNote | null = null
    let bestD = maxDist
    for (const note of notes) {
      if (note.author !== 'user') continue
      const d = bboxDistance(target, note.bbox)
      if (d < bestD) {
        bestD = d
        best = note
      }
    }
    return best
  }

  for (const s of numbered) {
    if (s.shape === 'loop') {
      for (const n of nodes) if (contains(s.bbox, n.bbox, 8)) s.encloses.push(n.id)
      for (const note of notes) if (contains(s.bbox, note.bbox, 8)) s.encloses.push(note.id)
      for (const g of strokeGroups) if (contains(s.bbox, g.bbox, 8)) s.encloses.push(g.id)
      for (const other of numbered) {
        if (other !== s && other.shape !== 'loop' && contains(s.bbox, other.bbox, 8)) s.encloses.push(other.id)
      }
      for (const { el: imgEl, image: img, src } of imageInfos) {
        if (contains(s.bbox, img.bbox, 8)) {
          s.encloses.push(img.id)
          continue
        }
        const inter = intersectBbox(s.bbox, img.bbox)
        if (!inter) continue
        const sArea = Math.max(1, s.bbox.w * s.bbox.h)
        const imgArea = Math.max(1, img.bbox.w * img.bbox.h)
        const interArea = inter.w * inter.h
        if (interArea >= 0.2 * Math.min(sArea, imgArea) && sArea < imgArea * 1.15) {
          const pixelBbox = src ? (canvasRectToImagePixels(s.bbox, img.bbox, src, imgEl.scale) ?? undefined) : undefined
          s.imageRegion = { imageId: img.id, canvasBbox: inter, pixelBbox }
          const nearNote = nearestFreeNote(s.bbox)
          img.annotations.push({
            kind: 'loop',
            by: s.id,
            canvasBbox: inter,
            pixelBbox,
            note: nearNote ? nearNote.text : null
          })
        }
      }
    }
    s.near = nearestTo(s.bbox, s.encloses)
  }

  // 识别落在图片内部的其他用户批注（矩形/椭圆框选、箭头指向、图上文字、图上手写组）并换算原图像素坐标
  for (const { el: imgEl, image: img, src } of imageInfos) {
    const imgArea = Math.max(1, img.bbox.w * img.bbox.h)
    for (const n of nodes) {
      if (n.author !== 'user' || !['rectangle', 'ellipse', 'diamond'].includes(n.kind)) continue
      const inter = intersectBbox(n.bbox, img.bbox)
      if (!inter) continue
      const nArea = Math.max(1, n.bbox.w * n.bbox.h)
      if (nArea < imgArea * 0.95 && inter.w * inter.h >= 0.5 * nArea) {
        const pixelBbox = src ? (canvasRectToImagePixels(n.bbox, img.bbox, src, imgEl.scale) ?? undefined) : undefined
        const nearNote = !n.label ? nearestFreeNote(n.bbox) : null
        img.annotations.push({
          kind: 'box',
          by: n.id,
          canvasBbox: inter,
          pixelBbox,
          note: n.label ?? (nearNote ? nearNote.text : null)
        })
      }
    }
    for (const e of edges) {
      if (e.author !== 'user') continue
      const arrowEl = byId.get(e.ref)
      if (!arrowEl) continue
      const pts = absPoints(arrowEl)
      if (!pts.length) continue
      const startHead = Boolean(arrowEl.startArrowhead)
      const endHead = Boolean(arrowEl.endArrowhead)
      const tip = startHead && !endHead ? pts[0] : pts[pts.length - 1]
      const tail = startHead && !endHead ? pts[pts.length - 1] : pts[0]
      if (tip[0] >= img.bbox.x && tip[0] <= img.bbox.x + img.bbox.w && tip[1] >= img.bbox.y && tip[1] <= img.bbox.y + img.bbox.h) {
        const pixelPoint = src ? (canvasPointToImagePixels(tip[0], tip[1], img.bbox, src, imgEl.scale) ?? undefined) : undefined
        const tailNote = !e.label ? nearestFreeNote({ x: tail[0] - 4, y: tail[1] - 4, w: 8, h: 8 }, 80) : null
        img.annotations.push({
          kind: 'arrow',
          by: e.ref,
          canvasBbox: { x: tip[0], y: tip[1], w: 1, h: 1 },
          pixelPoint,
          note: e.label ?? (tailNote ? tailNote.text : null)
        })
      }
    }
    for (const note of notes) {
      if (note.author !== 'user') continue
      if (contains(img.bbox, note.bbox, 8)) {
        const alreadyAttached = img.annotations.some((a) => a.note === note.text)
        if (!alreadyAttached) {
          const pixelBbox = src ? (canvasRectToImagePixels(note.bbox, img.bbox, src, imgEl.scale) ?? undefined) : undefined
          img.annotations.push({
            kind: 'text',
            by: note.id,
            canvasBbox: note.bbox,
            pixelBbox,
            note: note.text
          })
        }
      }
    }
    for (const g of strokeGroups) {
      if (contains(img.bbox, g.bbox, 8)) {
        const pixelBbox = src ? (canvasRectToImagePixels(g.bbox, img.bbox, src, imgEl.scale) ?? undefined) : undefined
        img.annotations.push({
          kind: 'stroke_group',
          by: g.id,
          canvasBbox: g.bbox,
          pixelBbox
        })
      }
    }
  }

  const needsImage =
    images.length > 0 ||
    lines.length > 0 ||
    strokeGroups.length > 0 ||
    numbered.length > MAX_LISTED_STROKES ||
    numbered.some((s) => s.shape === 'curve')

  return { nodes, edges, notes, strokes: numbered, strokeGroups, containment, images, lines, needsImage }
}

function nodeName(nodes: Map<string, SemanticNode>, id: string | null): string {
  if (!id) return '（空白处）'
  const n = nodes.get(id)
  if (!n) return id
  return n.label ? `${n.id}「${n.label}」` : `${n.id}（无文字${KIND_NAMES[n.kind] ?? n.kind}）`
}

// viewer：正在读这份描述的 agent 的名字。别的 agent 画的东西会单独标出来。
export function summarize(graph: SemanticGraph, meta: { board: string; version: number; viewer?: string | null }): string {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
  const edgeByRef = new Map(graph.edges.map((e) => [e.ref, e]))
  const strokeTotal = graph.strokes.length + graph.strokeGroups.reduce((sum, g) => sum + g.count, 0)
  const counts = [
    `${graph.nodes.length} 个节点`,
    `${graph.edges.length} 条连线`,
    graph.notes.length ? `${graph.notes.length} 段文字` : '',
    strokeTotal ? `${strokeTotal} 笔手绘` : '',
    graph.images.length ? `${graph.images.length} 张图片` : '',
    graph.lines.length ? `${graph.lines.length} 条线条` : ''
  ].filter(Boolean)
  const out: string[] = [`画板「${meta.board}」v${meta.version}：${counts.join('，')}`]
  // 没标的都是用户画的；agent 自己画的单独标出来，方便它分清哪些是用户的原意
  const byAgent = (x: { author: Author; agent: string | null; proposed: boolean }): string => {
    if (x.proposed) return '【agent 的提议，用户还没确认】'
    if (x.author !== 'agent') return ''
    return x.agent && meta.viewer && x.agent !== meta.viewer ? `【其他 agent（${x.agent}）画的】` : '【agent 画的】'
  }

  if (graph.nodes.length === 0 && graph.notes.length === 0 && strokeTotal === 0 && graph.images.length === 0) {
    out.push('（画板是空的）')
    return out.join('\n')
  }

  if (graph.nodes.length) {
    out.push('节点：')
    const parentOf = new Map(graph.containment.map((c) => [c.child, c.parent]))
    for (const n of graph.nodes) {
      const kind = KIND_NAMES[n.kind] ?? n.kind
      const parent = parentOf.get(n.id)
      out.push(`  ${n.id} ${n.label ? `「${n.label}」` : '（无文字）'}${kind}${parent ? `，在 ${nodeName(nodes, parent)} 里面` : ''}${byAgent(n)}`)
    }
  }

  if (graph.edges.length) {
    out.push('连线：')
    for (const e of graph.edges) {
      const arrow = e.directed === 'both' ? '↔' : e.directed === 'none' ? '—' : '→'
      const label = e.label ? `，标着「${e.label}」` : ''
      const guess = e.inferred ? '（端点没有吸附，按距离推测）' : ''
      out.push(`  ${nodeName(nodes, e.from)} ${arrow} ${nodeName(nodes, e.to)}${label}${guess}${byAgent(e)}`)
    }
  }

  if (graph.notes.length) {
    out.push('文字：')
    for (const note of graph.notes) {
      let where = '（单独放着）'
      if (note.attachedTo?.kind === 'node') where = `（在 ${nodeName(nodes, note.attachedTo.id)} ${note.position}）`
      if (note.attachedTo?.kind === 'edge') {
        const e = edgeByRef.get(note.attachedTo.id)
        if (e) where = `（在连线 ${e.from ?? '?'}→${e.to ?? '?'} 的${note.position}）`
      }
      out.push(`  ${note.id} 「${note.text}」${where}${byAgent(note)}`)
    }
  }

  const notesById = new Map(graph.notes.map((n) => [n.id, n]))
  const groupsById = new Map(graph.strokeGroups.map((g) => [g.id, g]))
  const strokesById = new Map(graph.strokes.map((s) => [s.id, s]))
  const imagesById = new Map(graph.images.map((i) => [i.id, i]))
  const enclosedLabel = (id: string): string => {
    if (nodes.has(id)) return nodeName(nodes, id)
    const note = notesById.get(id)
    if (note) return `${note.id}「${note.text}」`
    const group = groupsById.get(id)
    if (group) return `${group.id}（一组手写，${group.count} 笔）`
    const stroke = strokesById.get(id)
    if (stroke) return `${stroke.id}（一笔手绘）`
    const img = imagesById.get(id)
    if (img) return `${img.id}（图片）`
    return id
  }

  if (strokeTotal) {
    out.push('手绘：')
    for (const g of graph.strokeGroups) {
      const where = g.near ? `，在 ${nodeName(nodes, g.near.id)} ${g.near.position}` : g.region ? `，在画面${g.region}` : ''
      out.push(`  ${g.id} 一组手写或涂鸦（${g.count} 笔）${where}，内容请看附图`)
    }
    const shapeName = { loop: '一个圈', straight: '一条直线', curve: '一条曲线或涂鸦' }
    for (const s of graph.strokes.slice(0, MAX_LISTED_STROKES)) {
      const parts = [`${s.id} ${shapeName[s.shape]}`]
      if (s.encloses.length) parts.push(`圈住了 ${s.encloses.map(enclosedLabel).join('、')}`)
      if (s.imageRegion) {
        const r = s.imageRegion
        if (r.pixelBbox) {
          parts.push(`圈选了图片 ${r.imageId} 的原图像素区域 (${r.pixelBbox.x}, ${r.pixelBbox.y}, ${r.pixelBbox.w}×${r.pixelBbox.h})`)
        } else {
          parts.push(`圈选了图片 ${r.imageId} 的局部区域`)
        }
      }
      if (s.near) parts.push(`在 ${nodeName(nodes, s.near.id)} ${s.near.position}`)
      out.push(`  ${parts.join('，')}`)
    }
    const rest = graph.strokes.length - MAX_LISTED_STROKES
    if (rest > 0) out.push(`  ……另有 ${rest} 笔，请看附图`)
  }

  if (graph.images.length) {
    out.push(`图片：${graph.images.length} 张（内容请看附图；可用 trace_image 把图里的内容转成可编辑元素）`)
    for (const img of graph.images) {
      const metaBits: string[] = []
      if (img.naturalSize) metaBits.push(`原图 ${img.naturalSize.w}×${img.naturalSize.h} px`)
      if (img.meta?.url) metaBits.push(`来源 ${img.meta.url}`)
      else if (img.meta?.sourcePath) metaBits.push(`来源 ${img.meta.sourcePath}`)
      if (img.meta?.viewport) metaBits.push(`视口 ${img.meta.viewport.w}×${img.meta.viewport.h}`)
      if (img.meta?.round) metaBits.push(`第 ${img.meta.round} 轮结果`)
      const extra = metaBits.length ? `，${metaBits.join('，')}` : ''
      out.push(
        `  ${img.id} 左上角 (${Math.round(img.bbox.x)}, ${Math.round(img.bbox.y)})，画布上 ${Math.round(img.bbox.w)}×${Math.round(img.bbox.h)}${extra}${byAgent(img)}`
      )
      for (const ann of img.annotations) {
        const notePart = ann.note ? `，批注「${ann.note}」` : ''
        if (ann.kind === 'arrow') {
          const where = ann.pixelPoint
            ? `原图像素点 (${ann.pixelPoint.x}, ${ann.pixelPoint.y})`
            : `画布点 (${Math.round(ann.canvasBbox.x)}, ${Math.round(ann.canvasBbox.y)})`
          out.push(`    标注：箭头指向 ${where}${notePart}`)
        } else {
          const kindLabel =
            ann.kind === 'loop'
              ? `${ann.by}（手绘圈）圈选`
              : ann.kind === 'box'
                ? `${ann.by}（框选）框住`
                : ann.kind === 'stroke_group'
                  ? `${ann.by}（手写批注）落在`
                  : `${ann.by}（文字批注）落在`
          const where = ann.pixelBbox
            ? `原图像素区域 x=${ann.pixelBbox.x}, y=${ann.pixelBbox.y}, w=${ann.pixelBbox.w}, h=${ann.pixelBbox.h}`
            : `画布区域 (${Math.round(ann.canvasBbox.x)}, ${Math.round(ann.canvasBbox.y)}, ${Math.round(ann.canvasBbox.w)}×${Math.round(ann.canvasBbox.h)})`
          out.push(`    标注：${kindLabel}${where}${notePart}`)
        }
      }
    }
  }
  if (graph.lines.length) out.push(`线条：${graph.lines.length} 条没有箭头的折线（形状请看附图）`)
  return out.join('\n')
}
