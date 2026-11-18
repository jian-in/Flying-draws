// agent 的绘图指令（ops）→ 一份"绘图计划"：每个新元素的 id、位置、大小都在这里定好。
// 纯函数，不依赖 Electron。页面拿到计划后只负责把它变成 Excalidraw 元素。
//
// 新增：add_node、add_edge、add_text；trace_image 把一张图里的内容照原样转成可编辑元素。
// 改动：move、update_node、delete_node、update_edge、delete_edge、update_text、delete_text、delete_strokes、set_style。
// 改动可以用在任何人画的东西上（用户的、别的 agent 的都行，design.md 12.4）；还在等用户确认的提议除外。
// 排版：这一批里没指定坐标的新节点交给 dagre 排成一块，整块放在已有内容下方；
// 已有元素只在收到 move 指令时平移。
import dagre from '@dagrejs/dagre'
// 带 .ts 后缀：单元测试是用 node 直接跑这些文件的，node 不会自己补后缀
import { AUTO_TEXT_MAX_W, containerHeightFor, containerWidthFor, exitPoint, type ShapeBox } from './geometry.ts'
import { bboxOf, type Bbox, type SceneElement, type SemanticGraph } from './semantic.ts'

export interface FingerprintElement extends SceneElement {
  version?: number
  boundElements?: readonly { id: string; type: string }[] | null
  strokeColor?: string
  backgroundColor?: string
  fillStyle?: string
  strokeStyle?: string
  strokeWidth?: number
  opacity?: number
  roughness?: number
  roundness?: { type: number; value?: number } | null
  locked?: boolean
  link?: string | null
  fontSize?: number
  fontFamily?: number
  lineHeight?: number
  textAlign?: string
  verticalAlign?: string
  autoResize?: boolean
  originalText?: string
  pressures?: readonly number[]
  simulatePressure?: boolean
}

const textFingerprint = (text: FingerprintElement | undefined) => text ? [
  text.text, text.originalText, text.strokeColor, text.opacity, text.fontSize, text.fontFamily,
  text.lineHeight, text.textAlign, text.verticalAlign, text.autoResize
] : null

/**
 * 计算每个元素的冲突检测指纹。
 * - 普通元素使用实际内容、几何和样式，提议连线增删反向绑定时不会造成冲突；
 * - 已绑定到节点的箭头（startBinding / endBinding）：拖动或缩放端点节点时 Excalidraw 会连带递增箭头及其文字坐标的 version，
 *   但箭头的连接关系、折点数、文字内容与样式并未被改动，不应误判冲突；真改了连线文字、样式、方向、折点或自由端坐标时指纹仍会变化。
 */
export function elementFingerprints(elements: readonly FingerprintElement[]): Map<string, string> {
  const boundTextByContainer = new Map<string, FingerprintElement>()
  for (const el of elements) {
    if (!el.isDeleted && el.type === 'text' && el.containerId) {
      boundTextByContainer.set(el.containerId, el)
    }
  }
  const out = new Map<string, string>()
  for (const el of elements) {
    if (el.isDeleted) continue
    const bt = boundTextByContainer.get(el.id)
    if (el.type === 'arrow' && (el.startBinding || el.endBinding)) {
      const pts = el.points && el.points.length >= 2 ? el.points : ([[0, 0], [el.width, el.height]] as const)
      const first = pts[0]
      const last = pts[pts.length - 1]
      const freeStart = el.startBinding ? '' : `${Math.round(el.x + first[0])},${Math.round(el.y + first[1])}`
      const freeEnd = el.endBinding ? '' : `${Math.round(el.x + last[0])},${Math.round(el.y + last[1])}`
      const labelSig = bt ? `${bt.text ?? ''}\0${bt.strokeColor ?? ''}\0${bt.fontSize ?? ''}` : ''
      out.set(
        el.id,
        [
          'bound-arrow',
          el.startBinding?.elementId ?? '',
          el.endBinding?.elementId ?? '',
          el.startArrowhead ?? '',
          el.endArrowhead ?? '',
          pts.length,
          freeStart,
          freeEnd,
          el.strokeColor ?? '',
          el.strokeStyle ?? '',
          el.strokeWidth ?? '',
          el.opacity ?? '',
          el.customData?.flyingdraws?.layer ?? '',
          labelSig
        ].join('|')
      )
    } else {
      const crop = el.crop
      out.set(el.id, JSON.stringify([
        el.type, el.x, el.y, el.width, el.height, el.angle ?? 0,
        el.strokeColor, el.backgroundColor, el.fillStyle, el.strokeStyle, el.strokeWidth, el.opacity,
        el.roughness, el.roundness?.type, el.roundness?.value, el.locked, el.link,
        el.name, el.groupIds, el.frameId, el.containerId, el.fileId, el.scale,
        crop && [crop.x, crop.y, crop.width, crop.height, crop.naturalWidth, crop.naturalHeight],
        el.startArrowhead, el.endArrowhead, el.points, el.pressures, el.simulatePressure,
        el.customData?.flyingdraws?.layer, textFingerprint(el.type === 'text' ? el : undefined), textFingerprint(bt)
      ]))
    }
  }
  return out
}

export type NodeShape = 'rectangle' | 'ellipse' | 'diamond'
export type Direction = 'right' | 'down'
export type MoveSide = 'right' | 'left' | 'below' | 'above'

export interface StyleProps {
  color?: string // 线条和文字的颜色
  fill?: string // 填充色，只对节点有用；"transparent" 表示不填充
  shape?: NodeShape // 只对节点有用
  width?: number // 只对节点有用；中心不动
  height?: number
}

export type DrawOp =
  | { op: 'add_node'; id: string; label?: string; shape?: NodeShape; x?: number; y?: number }
  | { op: 'add_edge'; from: string; to: string; label?: string }
  | { op: 'add_text'; text: string; near?: string; x?: number; y?: number }
  // 下面这些会改动已有元素
  | { op: 'move'; id: string; x?: number; y?: number; dx?: number; dy?: number; near?: string; side?: MoveSide; gap?: number }
  | { op: 'update_node'; id: string; label: string }
  | { op: 'delete_node'; id: string }
  | { op: 'update_edge'; from: string; to: string; label: string }
  | { op: 'delete_edge'; from: string; to: string }
  | { op: 'update_text'; id: string; text: string } // 独立文字（T1 这类编号）
  | { op: 'delete_text'; id: string }
  | { op: 'delete_strokes'; id: string } // 一组手写或一笔手绘（S1 这类编号）
  | ({ op: 'set_style'; id?: string; from?: string; to?: string } & StyleProps) // id 是节点、文字或手绘；from + to 指一条连线
  | TraceImageOp

// 照着画布上的一张图（I1 这类编号），把图里的方框、文字、线条转成可编辑元素。
// 坐标都在 space 这个坐标系里（通常就是原图的像素尺寸），由这里按比例换算到画布上，agent 不用算画布坐标。
export interface TraceImageOp {
  op: 'trace_image'
  image: string // I1 这类编号，或图片元素的稳定 id
  space: { w: number; h: number }
  place?: 'beside' | 'over' // beside（默认）：画在原图旁边的空位，大小和原图一样；over：直接叠在原图上
  elements: TraceElement[]
}

export type TraceElement =
  | { kind: 'box'; id?: string; x: number; y: number; w: number; h: number; shape?: NodeShape; label?: string; color?: string; fill?: string; font_size?: number }
  | { kind: 'text'; x: number; y: number; text: string; color?: string; font_size?: number }
  | { kind: 'line'; points: [number, number][]; arrow?: 'none' | 'end' | 'start' | 'both'; color?: string; dashed?: boolean; from?: string; to?: string }

export const MODIFY_OPS = ['move', 'update_node', 'delete_node', 'update_edge', 'delete_edge', 'update_text', 'delete_text', 'delete_strokes', 'set_style']

export interface PlannedNode {
  key: string // agent 在 ops 里起的名字
  elementId: string
  shape: NodeShape
  label: string | null
  x: number
  y: number
  w: number
  h: number
  // 下面几项只有照图还原（trace_image）的元素才有：保留原图的颜色和字号，不换成席位颜色
  traced?: true
  color?: string
  fill?: string
  fontSize?: number
}

export interface PlannedEdge {
  elementId: string
  fromElementId: string
  toElementId: string
  label: string | null
  x: number // 起点
  y: number
  points: [number, number][] // 相对起点的折线，第一个点是 [0, 0]；超过两个点说明绕开了别的节点
}

export interface PlannedText {
  elementId: string
  text: string
  x: number
  y: number
  traced?: true
  color?: string
  fontSize?: number
}

// 照图还原出来的线条或箭头：不一定连着节点。from/to 给了就绑到对应的方框上，拖方框时线会跟着走。
export interface PlannedLine {
  elementId: string
  x: number // 起点
  y: number
  points: [number, number][] // 相对起点，第一个点是 [0, 0]
  startArrow: boolean
  endArrow: boolean
  color?: string
  dashed: boolean
  fromElementId?: string
  toElementId?: string
}

export interface PlannedMove {
  id: string // 指令里的目标编号（rebase 后，如 N1 / T1 / S1 / I1 或稳定 id）
  kind: 'node' | 'text' | 'strokes' | 'image'
  targetKey: string // 主元素 Excalidraw id（节点/文字/图片为自身 id，手绘组为首笔 id）
  elementIds: string[] // 要平移的全部底层元素 id（手绘组含组内全部笔画；节点内绑定文字由渲染端随容器平移）
  dx: number
  dy: number
  fromBbox: Bbox
  toBbox: Bbox
  toTopLeft?: { x: number; y: number } // x,y / near 绝对目标左上角（渲染端按实测扩宽后框体对齐此左上角，消除估算偏差）
  adjusted?: boolean // near 理想贴边位被占而发生避障滑动时为 true
  overlaps?: string[] // x,y / dx,dy 精确落位与已有非自身元素重叠时的提示编号（如 ["N4"]）
}

export interface PlannedReroute {
  arrowId: string
  fromElementId?: string
  toElementId?: string
  x: number
  y: number
  points: [number, number][] // 相对起点的折线，首点 [0, 0]
}

// 提议层里的移动落点虚线框：用户可直接拖拽调整最终落点，或删掉它/原位标记框来否决这次移动
export interface PlannedMoveGhost {
  ghostId: string
  frameId: string // 关联的原位 PlannedMarker.frameId
  targetKey: string
  elementIds: string[]
  x: number
  y: number
  w: number
  h: number
  dx: number // 计划平移量
  dy: number
  label: string // 框内提示文字，如"「登录」移到这里"
  summary: string // 否决/调整时拼给 agent 的主语，如"移动节点「登录」"
}

export interface DrawPlan {
  nodes: PlannedNode[]
  edges: PlannedEdge[]
  texts: PlannedText[]
  lines?: PlannedLine[] // 只有 trace_image 会产生
  // 换掉节点里或连线上的文字；textId 是新文字元素的 id。relayout 为 true 表示文字没变，只是节点改了形状或大小，要重新摆一下
  updates: { elementId: string; textId: string; label: string | null; relayout?: boolean }[]
  textEdits: { elementId: string; text: string }[] // 改独立文字的内容
  styles: PlannedStyle[]
  deletes: string[] // 要删的元素（节点、连线、独立文字、手绘笔画）。绑在上面的文字、连着被删节点的 agent 连线由页面一并处理
  moves: PlannedMove[] // 要平移的元素（节点、独立文字、手绘单笔/整组、图片）
  reroutes?: PlannedReroute[] // 节点移动后，主进程为受影响连线重新算出的绕障折线
  markers: PlannedMarker[] // 只有提议里才有：改动先不执行，画一个标记框告诉用户"打算改这里"
  moveGhosts?: PlannedMoveGhost[] // 只有提议里才有：移动目标落点的可拖拽虚线预览框
  targetGroups: string[][] // 每条改动指令对应的元素。一组手写是好几个元素，要合在一起标记
  existingRefs: string[] // 这批指令引用到的已有元素（Excalidraw id），页面执行前要确认它们还在
  // 用稳定 id（元素自己的 id）而不是 N1/I1 这类短编号引用的元素：不会随版本错位，不要求 base_version，但执行前同样要确认还在
  stableRefs?: string[]
  modifiedRefs: string[] // 其中要被改动或删除的。这些元素在 agent 读过之后不能被别人动过
}

export interface PlannedStyle {
  elementId: string
  color?: string
  fill?: string
  shape?: NodeShape
  w?: number
  h?: number
}

// 提议里的一处改动：围着目标画一个虚线框，旁边写上打算怎么改。用户把框删掉就表示不同意这一处。
export interface PlannedMarker {
  frameId: string
  noteId: string
  x: number
  y: number
  w: number
  h: number
  tone: 'delete' | 'change' // 删除用红色，其他改动用蓝色
  note: string // 写在框旁边的话，如"删除"、"改成「登录」"
  targets: string[] // 这个标记对应的元素
  summary: string // 给 agent 看的一句话，如"删除节点「登录」"
}

// 提议被接受时才执行的改动。存在请求上，跟着 pending.json 落盘。
export interface PendingChanges {
  updates: DrawPlan['updates']
  textEdits: DrawPlan['textEdits']
  styles: PlannedStyle[]
  deletes: string[]
  moves?: PlannedMove[]
  reroutes?: PlannedReroute[]
  moveGhosts?: {
    ghostId: string
    frameId: string
    targetKey: string
    elementIds: string[]
    x: number
    y: number
    dx: number
    dy: number
    summary: string
  }[]
  markers: { frameId: string; targets: string[]; summary: string }[]
}

// agent 上一次读到的编号 → 现在的编号。
// N1 这类编号按阅读顺序排，画板一变就可能指向别的节点；这里用 agent 读的那个版本的对照表，
// 把指令里的旧编号换成同一个元素现在的编号。元素已经不在了的，记进 gone。
export function rebaseOps(
  ops: readonly DrawOp[],
  base: readonly { id: string; ref: string; refs?: readonly string[] }[],
  graph: SemanticGraph
): { ops: DrawOp[]; gone: string[] } {
  const fresh = new Set(ops.flatMap((op) => (op.op === 'add_node' ? [String(op.id).trim()] : [])))
  const priorById = new Map(base.map((item) => [item.id, item]))
  const strokeGroups = new Map(graph.strokeGroups.map((group) => [group.id, group.refs]))
  // 元素 → 现在的编号。手绘分组只有在全部成员仍组成同一组时才重映射。
  const nowOf = new Map<string, string>()
  for (const n of graph.nodes) nowOf.set(n.ref, n.id)
  for (const n of graph.notes) nowOf.set(n.ref, n.id)
  for (const s of graph.strokes) nowOf.set(s.ref, s.id)
  for (const g of graph.strokeGroups) for (const ref of g.refs) nowOf.set(ref, g.id)
  for (const img of graph.images) nowOf.set(img.ref, img.id)
  const gone = new Set<string>()
  const fix = <T>(id: T): T => {
    if (typeof id !== 'string') return id
    const key = id.trim()
    const prior = fresh.has(key) ? undefined : priorById.get(key)
    if (!prior) return key as T
    const now = nowOf.get(prior.ref)
    const refs = prior.refs
    if (!now || (refs && refs.length > 1 && (
      strokeGroups.get(now)?.length !== refs.length || refs.some((ref) => nowOf.get(ref) !== now)
    ))) {
      gone.add(prior.id)
      return key as T
    }
    return now as T
  }
  const out = ops.map((op): DrawOp => {
    switch (op.op) {
      case 'add_edge':
      case 'update_edge':
      case 'delete_edge':
        return { ...op, from: fix(op.from), to: fix(op.to) }
      case 'add_text':
        return { ...op, near: fix(op.near) }
      case 'move':
        return { ...op, id: fix(op.id), ...(op.near !== undefined ? { near: fix(op.near) } : {}) }
      case 'update_node':
      case 'delete_node':
      case 'update_text':
      case 'delete_text':
      case 'delete_strokes':
        return { ...op, id: fix(op.id) }
      case 'set_style':
        return { ...op, id: fix(op.id), from: fix(op.from), to: fix(op.to) }
      case 'trace_image':
        return { ...op, image: fix(op.image) }
      default:
        return op
    }
  })
  return { ops: out, gone: [...gone] }
}

export class OpsError extends Error {}

const NODE_MIN_W = 120
const NODE_H = 60
const NODE_SEP = 50 // 同一层里相邻节点的间距
const RANK_SEP = 70 // 相邻两层的间距（连线上有文字时 dagre 会再加宽）
const BLOCK_GAP = 100 // 新画的一块离已有内容多远
const EDGE_GAP = 8 // 箭头端点离节点轮廓多远
const TEXT_GAP = 14
const FONT_SIZE = 20
const LINE_H = FONT_SIZE * 1.25
const BOUND_TEXT_INSET = 10 // Excalidraw 0.18.1 的绑定文字四边各留 5px
const START: [number, number] = [100, 100] // 空画板上新内容的左上角

// 估算一段文字的宽度：中日韩文字按一个字号宽，其他按 0.6 个字号。
// 只用来定节点大小和给排版留空，页面里真正的文字尺寸由 Excalidraw 量。
export function estimateTextWidth(text: string): number {
  let longest = 0
  for (const line of text.split('\n')) {
    let w = 0
    for (const ch of line) w += /[⺀-鿿가-힯＀-￯]/.test(ch) ? FONT_SIZE : FONT_SIZE * 0.6
    if (w > longest) longest = w
  }
  return Math.ceil(longest)
}

function textSize(text: string): { w: number; h: number } {
  return { w: estimateTextWidth(text), h: Math.ceil(text.split('\n').length * LINE_H) }
}

function nodeSize(shape: NodeShape, label: string | null): { w: number; h: number } {
  const t = label ? textSize(label) : { w: 0, h: LINE_H }
  return {
    w: containerWidthFor(shape, t.w, NODE_MIN_W),
    h: containerHeightFor(shape, t.h, NODE_H)
  }
}

type Box = ShapeBox
export { exitPoint }

// ---------- 给新画的一块找落笔的位置 ----------

const PLACE_MARGIN = 30 // 新的一块和已有内容之间至少留这么宽
const PLACE_STEP = 40

const overlaps = (a: Bbox, b: Bbox, margin = 0): boolean =>
  a.x < b.x + b.w + margin && a.x + a.w + margin > b.x && a.y < b.y + b.h + margin && a.y + a.h + margin > b.y

const inside = ([x, y]: [number, number], box: Bbox): boolean =>
  x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h

export function placeBeside(
  size: { w: number; h: number },
  anchor: Bbox,
  side: MoveSide,
  gap: number,
  obstacles: readonly Bbox[]
): { x: number; y: number; adjusted: boolean } {
  const center = centerOf(anchor)
  const others = obstacles.filter((box) => !inside(center, box))
  const horizontal = side === 'right' || side === 'left'
  const sign = side === 'right' || side === 'below' ? 1 : -1
  const x = side === 'right' ? anchor.x + anchor.w + gap : side === 'left' ? anchor.x - size.w - gap : center[0] - size.w / 2
  const y = side === 'below' ? anchor.y + anchor.h + gap : side === 'above' ? anchor.y - size.h - gap : center[1] - size.h / 2
  const free = (x: number, y: number) => !others.some((box) => overlaps({ x, y, ...size }, box, DETOUR_PAD))
  if (free(x, y)) return { x, y, adjusted: false }
  for (let k = 1; k <= 10; k++) {
    for (const offset of [PLACE_STEP * k, -PLACE_STEP * k]) {
      const nx = x + (horizontal ? 0 : offset)
      const ny = y + (horizontal ? offset : 0)
      if (free(nx, ny)) return { x: nx, y: ny, adjusted: true }
    }
  }
  for (let k = 1; k <= 8; k++) {
    const offset = PLACE_STEP * k * sign
    const nx = x + (horizontal ? offset : 0)
    const ny = y + (horizontal ? 0 : offset)
    if (free(nx, ny)) return { x: nx, y: ny, adjusted: true }
  }
  const bottom = others.reduce((max, box) => Math.max(max, box.y + box.h), anchor.y + anchor.h)
  const [nx, ny] = placeBlock(size, others, {
    anchors: [anchor],
    direction: horizontal ? 'right' : 'down',
    fallback: [center[0] - size.w / 2, bottom + BLOCK_GAP]
  })
  return { x: nx, y: ny, adjusted: true }
}

// 新的一块放哪儿，返回它的左上角。
// - 连着已有节点：紧挨着那些节点放。先试顺着排版方向的那一侧（横排试右边，竖排试下面），被占了试另一侧，
//   两侧都被占就从正下方一路往下找到第一处空位——不再一律甩到整张画布的最底下。
// - 不连已有节点：知道用户当前的视野时，放进视野里第一处放得下的空位；
//   视野里放不下，就放在视野这一竖条里已有内容的下面。不知道视野时退回老办法：所有内容的最下方。
export function placeBlock(
  size: { w: number; h: number },
  obstacles: readonly Bbox[],
  opts: { anchors?: readonly Bbox[]; direction?: Direction; view?: Bbox | null; fallback: [number, number] }
): [number, number] {
  const free = (r: Bbox): boolean => !obstacles.some((o) => overlaps(r, o, PLACE_MARGIN))
  const anchors = opts.anchors ?? []
  if (anchors.length) {
    const x0 = Math.min(...anchors.map((a) => a.x))
    const y0 = Math.min(...anchors.map((a) => a.y))
    const x1 = Math.max(...anchors.map((a) => a.x + a.w))
    const y1 = Math.max(...anchors.map((a) => a.y + a.h))
    // 中线按各个节点中心的平均算，和原来「对齐到这些节点正下方」的算法一致
    const cx = anchors.reduce((sum, a) => sum + a.x + a.w / 2, 0) / anchors.length
    const cy = anchors.reduce((sum, a) => sum + a.y + a.h / 2, 0) / anchors.length
    const reach = BLOCK_GAP - PLACE_MARGIN - 1 // 检查空位时把到节点之间的那段过道也算上，免得连线从别的东西上压过去
    const below = { x: cx - size.w / 2, y: y1 + BLOCK_GAP, w: size.w, h: size.h }
    const right = { x: x1 + BLOCK_GAP, y: cy - size.h / 2, w: size.w, h: size.h }
    const belowFree = free({ ...below, y: below.y - reach, h: below.h + reach })
    const rightFree = free({ ...right, x: right.x - reach, w: right.w + reach })
    const order = opts.direction === 'down' ? (['below', 'right'] as const) : (['right', 'below'] as const)
    for (const side of order) {
      if (side === 'below' && belowFree) return [below.x, below.y]
      if (side === 'right' && rightFree) return [right.x, right.y]
    }
    for (let i = 1; i <= 400; i++) {
      const y = below.y + i * PLACE_STEP
      if (free({ ...below, y })) return [below.x, y]
    }
    return opts.fallback
  }

  const view = opts.view
  if (view && view.w > 0 && view.h > 0) {
    if (size.w <= view.w && size.h <= view.h) {
      for (let y = view.y; y + size.h <= view.y + view.h; y += PLACE_STEP) {
        for (let x = view.x; x + size.w <= view.x + view.w; x += PLACE_STEP) {
          if (free({ x, y, w: size.w, h: size.h })) return [x, y]
        }
      }
    }
    const column = obstacles.filter((o) => o.x < view.x + view.w && o.x + o.w > view.x)
    return [view.x, column.length ? Math.max(...column.map((o) => o.y + o.h)) + BLOCK_GAP : view.y]
  }
  return opts.fallback
}

// 线段有没有穿过一个框（Liang–Barsky）
function segmentHits(a: [number, number], b: [number, number], box: Bbox, pad = 0): boolean {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  let t0 = 0
  let t1 = 1
  const edges: [number, number][] = [
    [-dx, a[0] - (box.x - pad)],
    [dx, box.x + box.w + pad - a[0]],
    [-dy, a[1] - (box.y - pad)],
    [dy, box.y + box.h + pad - a[1]]
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
  }
  return true
}

const DETOUR_PAD = 12
const DETOUR_STEP = 20

// 两个节点之间的直线如果会压到别的东西，给它加一个拐点绕开：在线段中点的垂直方向上，
// 往两边由近到远地试，取第一处让两段线都不压东西的位置。绕不开就返回 null，照旧画直线。
export function detourPoint(a: [number, number], b: [number, number], obstacles: readonly Bbox[]): [number, number] | null {
  // 起点或终点落在里面的框不算障碍：那是这两个节点自己，或者圈着它们的大框
  const others = obstacles.filter((o) => !inside(a, o) && !inside(b, o))
  const blocked = (p: [number, number], q: [number, number]) => others.some((o) => segmentHits(p, q, o, DETOUR_PAD))
  if (!blocked(a, b)) return null
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  if (len < 1) return null
  const nx = -(b[1] - a[1]) / len
  const ny = (b[0] - a[0]) / len
  const mx = (a[0] + b[0]) / 2
  const my = (a[1] + b[1]) / 2
  for (let d = DETOUR_STEP * 2; d <= 800; d += DETOUR_STEP) {
    for (const sign of [1, -1]) {
      const p: [number, number] = [mx + nx * d * sign, my + ny * d * sign]
      if (!blocked(a, p) && !blocked(p, b)) return p
    }
  }
  return null
}

/**
 * 连线绕障路径：优先单拐点绕行；若密集多障碍导致单拐点无法同时避开两端障碍，
 * 退而尝试双拐点平行走廊绕行（[p1, p2]），再绕不开才返回空数组画直线。
 */
export function detourPath(a: [number, number], b: [number, number], obstacles: readonly Bbox[]): [number, number][] {
  const single = detourPoint(a, b, obstacles)
  if (single) return [single]
  const others = obstacles.filter((o) => !inside(a, o) && !inside(b, o))
  const blocked = (p: [number, number], q: [number, number]) => others.some((o) => segmentHits(p, q, o, DETOUR_PAD))
  if (!blocked(a, b)) return []
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  if (len < 1) return []
  const nx = -dy / len
  const ny = dx / len
  for (const [t1, t2] of [
    [0.2, 0.8],
    [0.05, 0.95]
  ] as const) {
    for (let d = DETOUR_STEP * 2; d <= 800; d += DETOUR_STEP) {
      for (const sign of [1, -1]) {
        const p1: [number, number] = [a[0] + dx * t1 + nx * d * sign, a[1] + dy * t1 + ny * d * sign]
        const p2: [number, number] = [a[0] + dx * t2 + nx * d * sign, a[1] + dy * t2 + ny * d * sign]
        if (!blocked(a, p1) && !blocked(p1, p2) && !blocked(p2, b)) return [p1, p2]
      }
    }
  }
  return []
}

function centerOf(b: Bbox): [number, number] {
  return [b.x + b.w / 2, b.y + b.h / 2]
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function cleanLabel(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

const COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
const SIZE_MIN = 20
const SIZE_MAX = 4000

// 校验 set_style 里的样式，只留下真正给了的那几项
function styleProps(op: StyleProps, where: string): Omit<PlannedStyle, 'elementId'> {
  const out: Omit<PlannedStyle, 'elementId'> = {}
  if (op.color !== undefined) {
    if (typeof op.color !== 'string' || !COLOR_RE.test(op.color)) throw new OpsError(`${where}: "color" must be a hex color like "#e03131"`)
    out.color = op.color.toLowerCase()
  }
  if (op.fill !== undefined) {
    if (typeof op.fill !== 'string' || (op.fill !== 'transparent' && !COLOR_RE.test(op.fill))) {
      throw new OpsError(`${where}: "fill" must be a hex color like "#ffec99", or "transparent"`)
    }
    out.fill = op.fill.toLowerCase()
  }
  if (op.shape !== undefined) {
    if (!['rectangle', 'ellipse', 'diamond'].includes(op.shape)) throw new OpsError(`${where}: unknown shape "${String(op.shape)}"`)
    out.shape = op.shape
  }
  const size = (v: unknown, name: string): number | undefined => {
    if (v === undefined) return undefined
    if (!isFiniteNumber(v) || v < SIZE_MIN || v > SIZE_MAX) throw new OpsError(`${where}: "${name}" must be a number between ${SIZE_MIN} and ${SIZE_MAX}`)
    return Math.round(v)
  }
  const w = size(op.width, 'width')
  const h = size(op.height, 'height')
  if (w !== undefined) out.w = w
  if (h !== undefined) out.h = h
  if (!Object.keys(out).length) throw new OpsError(`${where}: set_style needs at least one of color, fill, shape, width, height`)
  return out
}

const MOVE_LIMIT = 1e6
const MOVE_SIDES: readonly MoveSide[] = ['right', 'left', 'below', 'above']
type MovePosition =
  | { mode: 'absolute'; x: number; y: number }
  | { mode: 'relative'; dx: number; dy: number }
  | { mode: 'near'; near: string; side: MoveSide; gap: number }

function moveNumber(value: unknown, field: string, where: string): number {
  if (!isFiniteNumber(value) || Math.abs(value) > MOVE_LIMIT) {
    throw new OpsError(`${where}: ${field} must be a finite number between -${MOVE_LIMIT} and ${MOVE_LIMIT}`)
  }
  return value
}

function movePosition(op: Extract<DrawOp, { op: 'move' }>, where: string): MovePosition {
  const absolute = op.x !== undefined || op.y !== undefined
  const relative = op.dx !== undefined || op.dy !== undefined
  const near = op.near !== undefined
  if (Number(absolute) + Number(relative) + Number(near) !== 1) {
    throw new OpsError(`${where}: move needs exactly one of x/y, dx/dy, or near`)
  }
  if (near) {
    if (typeof op.near !== 'string' || !op.near.trim()) throw new OpsError(`${where}: near must be a non-empty id`)
    const side = op.side === undefined ? 'right' : op.side
    if (!MOVE_SIDES.includes(side)) throw new OpsError(`${where}: side must be right, left, below, or above`)
    const gap = op.gap === undefined ? 40 : op.gap
    if (!isFiniteNumber(gap) || gap < 0 || gap > 400) throw new OpsError(`${where}: gap must be a finite number between 0 and 400`)
    return { mode: 'near', near: op.near.trim(), side, gap }
  }
  if (op.side !== undefined || op.gap !== undefined) throw new OpsError(`${where}: side and gap require near`)
  if (absolute) {
    if (op.x === undefined || op.y === undefined) throw new OpsError(`${where}: x and y must be provided together`)
    return { mode: 'absolute', x: moveNumber(op.x, 'x', where), y: moveNumber(op.y, 'y', where) }
  }
  return {
    mode: 'relative',
    dx: op.dx === undefined ? 0 : moveNumber(op.dx, 'dx', where),
    dy: op.dy === undefined ? 0 : moveNumber(op.dy, 'dy', where)
  }
}

interface MoveTarget {
  id: string
  kind: PlannedMove['kind']
  elementIds: string[]
  bbox: Bbox
  proposed: boolean
}

function moveTargets(graph: SemanticGraph): MoveTarget[] {
  const single = (item: { id: string; ref: string; bbox: Bbox; proposed?: boolean }, kind: PlannedMove['kind']): MoveTarget =>
    ({ id: item.id, kind, elementIds: [item.ref], bbox: item.bbox, proposed: item.proposed ?? false })
  return [
    ...graph.nodes.filter((node) => node.kind !== 'line').map((node) => single(node, 'node')),
    ...graph.notes.map((note) => single(note, 'text')),
    ...graph.strokes.map((stroke) => single(stroke, 'strokes')),
    ...graph.strokeGroups.map((group): MoveTarget => ({ ...group, elementIds: group.refs, kind: 'strokes', proposed: false })),
    ...graph.images.map((image) => single(image, 'image'))
  ]
}

function resizedNodeBox(old: Box, style: PlannedStyle | undefined, update: DrawPlan['updates'][number] | undefined): Box {
  const shape = style?.shape ?? old.shape
  const label = update?.label
  const autoWidth = label && (!update.relayout || shape !== old.shape)
    ? containerWidthFor(shape, Math.min(estimateTextWidth(label), AUTO_TEXT_MAX_W), NODE_MIN_W)
    : old.w
  const w = style?.w ?? Math.max(old.w, autoWidth)
  // 估算文字按 Excalidraw 的有效内宽折行后所需的高度。
  const innerScale = shape === 'diamond' ? 0.5 : shape === 'ellipse' ? Math.SQRT1_2 : 1
  const innerWidth = Math.max(1, Math.round(w * innerScale) - BOUND_TEXT_INSET)
  const lineCount = label ? label.split('\n').reduce((sum, line) => {
    const lines = Math.min(Array.from(line).length, Math.ceil(estimateTextWidth(line) / innerWidth))
    return sum + Math.max(1, lines)
  }, 0) : 0
  const minHeight = Math.round((lineCount * LINE_H + BOUND_TEXT_INSET) / innerScale)
  const h = style?.h ?? (label ? Math.max(old.h, NODE_H, minHeight) : old.h)
  return { x: old.x + (old.w - w) / 2, y: old.y + (old.h - h) / 2, w, h, shape }
}

function routeBetween(from: Box, to: Box, obstacles: readonly Bbox[], bends: [number, number][] = []): Omit<PlannedReroute, 'arrowId'> {
  const start = centerOf(from)
  const end = centerOf(to)
  const route = [start, ...bends, end]
  const nextPoints = route.slice(1)
  const clear = bends.length > 0 && !obstacles.some((box) => !inside(start, box) && !inside(end, box)
    && nextPoints.some((point, i) => segmentHits(route[i], point, box, DETOUR_PAD)))
  const mid = clear ? bends : detourPath(start, end, obstacles)
  const [x, y] = exitPoint(from, ...(mid[0] ?? end), EDGE_GAP)
  const exit = exitPoint(to, ...(mid[mid.length - 1] ?? start), EDGE_GAP)
  return { x, y, points: [[0, 0], ...[...mid, exit].map(([px, py]): [number, number] => [px - x, py - y])] }
}

export function planOps(
  ops: readonly DrawOp[],
  graph: SemanticGraph,
  newId: () => string,
  opts: { direction?: Direction; view?: Bbox | null; elements?: readonly SceneElement[] } = {} // elements 提供手绘成员与箭头的底层信息
): DrawPlan {
  if (!Array.isArray(ops) || ops.length === 0) throw new OpsError('ops must be a non-empty array')
  const direction: Direction = opts.direction === 'down' ? 'down' : 'right'

  // 已有节点：agent 用上一次读到的短编号（N1、N2……）引用
  const existing = new Map(graph.nodes.map((n) => [n.id, n]))
  const rawById = new Map(opts.elements?.filter((el) => !el.isDeleted).map((el) => [el.id, el]))

  // ---------- 第一遍：新节点（先定大小，位置等排版） ----------
  const nodes: PlannedNode[] = []
  const byKey = new Map<string, PlannedNode>()
  const auto = new Set<string>() // 没指定坐标、要自动排版的节点
  ops.forEach((op, i) => {
    if (op.op !== 'add_node') return
    const key = String(op.id ?? '').trim()
    if (!key) throw new OpsError(`ops[${i}]: add_node needs an "id"`)
    if (existing.has(key)) throw new OpsError(`ops[${i}]: id "${key}" is already a node on the canvas; pick another id for the new node`)
    if (byKey.has(key)) throw new OpsError(`ops[${i}]: duplicate node id "${key}"`)
    const shape: NodeShape = op.shape ?? 'rectangle'
    if (!['rectangle', 'ellipse', 'diamond'].includes(shape)) throw new OpsError(`ops[${i}]: unknown shape "${String(op.shape)}"`)
    const label = cleanLabel(op.label)
    const placed = isFiniteNumber(op.x) && isFiniteNumber(op.y)
    const node: PlannedNode = { key, elementId: newId(), shape, label, x: placed ? op.x! : 0, y: placed ? op.y! : 0, ...nodeSize(shape, label) }
    if (!placed) auto.add(key)
    nodes.push(node)
    byKey.set(key, node)
  })

  // ---------- 第二遍：连线和文字，这里只校验引用，不算位置 ----------
  const existingRefs = new Set<string>()
  const stableRefs = new Set<string>()
  const edgeOps: { from: string; to: string; label: string | null }[] = []
  const traceOps: { op: TraceImageOp; where: string }[] = []
  const textOps: { text: string; near: string | null; x: number | null; y: number | null }[] = []
  const moveOps: { id: string; target: MoveTarget; anchor?: MoveTarget; position: MovePosition; where: string }[] = []
  const movingRefs = new Set<string>()

  // 改动和删除：谁画的都能动（用户的、别的 agent 的），只有还在等用户确认的提议不行
  const updates: DrawPlan['updates'] = []
  const nodeUpdateIndexes = new Map<string, number>()
  const textEdits: DrawPlan['textEdits'] = []
  const styles = new Map<string, PlannedStyle>()
  const relayout = new Map<string, string>() // 改了形状或大小的节点 → 它里面的文字（要重新摆）
  const targetGroups: string[][] = []
  const deletes = new Set<string>()
  const modifiedRefs = new Set<string>()
  const deletedKeys = new Set<string>()
  const targets = moveTargets(graph)
  const targetsById = new Map(targets.map((target) => [target.id, target]))
  const targetsByRef = new Map(targets.filter((target) => target.elementIds.length === 1).map((target) => [target.elementIds[0], target]))
  const groupedMemberRefs = new Set(graph.strokeGroups.flatMap((group) => group.refs))
  for (const group of graph.strokeGroups) {
    for (const ref of group.refs) {
      const el = rawById.get(ref)
      if (!el) continue
      targetsByRef.set(ref, { id: group.id, kind: 'strokes', elementIds: [ref], bbox: bboxOf(el), proposed: false })
    }
  }
  const lineRefs = new Set([...graph.edges.map((edge) => edge.ref), ...graph.lines.map((line) => line.ref)])
  const proposedEdges = new Set(graph.edges.filter((edge) => edge.proposed).map((edge) => edge.ref))
  const requireSettledRef = (id: string, where: string, target = targetsById.get(id) ?? targetsByRef.get(id)): void => {
    const proposed = target?.proposed || existing.get(id)?.proposed || proposedEdges.has(id) || (target?.elementIds ?? [id]).some(
      (ref) => rawById.get(ref)?.customData?.flyingdraws?.layer === 'proposal'
    )
    if (proposed) throw new OpsError(`${where}: element ${id} is part of a proposal the user has not answered yet. Wait for their answer (canvas_wait) first.`)
  }
  const check = (key: string, where: string): string => {
    if (byKey.has(key)) return key
    requireSettledRef(key, where)
    const old = existing.get(key)
    if (old) {
      existingRefs.add(old.ref)
      return key
    }
    throw new OpsError(`${where}: unknown node "${key}". Use an id from an add_node in this call, or a node id (like N1) from your latest canvas_read`)
  }
  const moveTarget = (id: string, where: string, anchor = false): MoveTarget => {
    const target = targetsById.get(id) ?? targetsByRef.get(id)
    requireSettledRef(id, where, target)
    if (!target) {
      if (lineRefs.has(id) || existing.get(id)?.kind === 'line') {
        throw new OpsError(`${where}: move cannot ${anchor ? 'use a line or arrow as an anchor' : 'move a line or arrow'}`)
      }
      throw new OpsError(`${where}: unknown element "${id}". Use an existing N, T, S, or I id, or its stable element id`)
    }
    const refs = targetsById.has(id) ? existingRefs : stableRefs
    for (const ref of target.elementIds) refs.add(ref)
    return target
  }
  const oldNode = (key: string, where: string) => {
    requireSettledRef(key, where)
    const node = existing.get(key)
    if (!node) {
      throw new OpsError(
        byKey.has(key)
          ? `${where}: "${key}" is being added in this same call; just add it the way you want it`
          : `${where}: unknown node "${key}". Use a node id (like N1) from your latest canvas_read`
      )
    }
    return node
  }
  const oldEdge = (from: string, to: string, where: string) => {
    for (const key of [from, to]) {
      requireSettledRef(key, where)
      if (!existing.has(key)) throw new OpsError(`${where}: unknown node "${key}". Use node ids (like N1) from your latest canvas_read`)
    }
    const edge =
      graph.edges.find((e) => e.from === from && e.to === to) ??
      graph.edges.find((e) => e.directed !== 'forward' && e.from === to && e.to === from) // 没有方向或双向的线，两头反着说也认
    if (!edge) throw new OpsError(`${where}: there is no arrow from ${from} to ${to} on the canvas`)
    requireSettledRef(edge.ref, where)
    return edge
  }
  const notesById = new Map(graph.notes.map((n) => [n.id, n]))
  const oldText = (key: string, where: string) => {
    requireSettledRef(key, where)
    const note = notesById.get(key)
    if (!note) throw new OpsError(`${where}: unknown text "${key}". Use a text id (like T1) from your latest canvas_read`)
    return note
  }
  const strokeRefs = new Map<string, string[]>([
    ...graph.strokeGroups.map((g): [string, string[]] => [g.id, g.refs]),
    ...graph.strokes.map((s): [string, string[]] => [s.id, [s.ref]])
  ])
  const oldStrokes = (key: string, where: string): string[] => {
    requireSettledRef(key, where)
    const refs = strokeRefs.get(key)
    if (!refs) throw new OpsError(`${where}: unknown hand-drawn strokes "${key}". Use a stroke id (like S1) from your latest canvas_read`)
    return refs
  }
  const touch = (refs: string[]): void => {
    for (const ref of refs) {
      existingRefs.add(ref)
      modifiedRefs.add(ref)
    }
    targetGroups.push(refs)
  }

  ops.forEach((op, i) => {
    if (op.op === 'update_node' || op.op === 'delete_node') {
      const node = oldNode(String(op.id ?? '').trim(), `ops[${i}].id`)
      touch([node.ref])
      if (op.op === 'delete_node') {
        deletes.add(node.ref)
        deletedKeys.add(node.id)
      } else {
        const index = nodeUpdateIndexes.get(node.ref) ?? updates.length
        nodeUpdateIndexes.set(node.ref, index)
        updates[index] = { elementId: node.ref, textId: newId(), label: cleanLabel(op.label) }
      }
    } else if (op.op === 'update_edge' || op.op === 'delete_edge') {
      const edge = oldEdge(String(op.from ?? '').trim(), String(op.to ?? '').trim(), `ops[${i}]`)
      touch([edge.ref])
      if (op.op === 'delete_edge') deletes.add(edge.ref)
      else updates.push({ elementId: edge.ref, textId: newId(), label: cleanLabel(op.label) })
    } else if (op.op === 'update_text' || op.op === 'delete_text') {
      const note = oldText(String(op.id ?? '').trim(), `ops[${i}].id`)
      touch([note.ref])
      if (op.op === 'delete_text') {
        deletes.add(note.ref)
      } else {
        const text = String(op.text ?? '').trim()
        if (!text) throw new OpsError(`ops[${i}]: update_text needs "text". To remove the text, use delete_text`)
        textEdits.push({ elementId: note.ref, text })
      }
    } else if (op.op === 'delete_strokes') {
      const refs = oldStrokes(String(op.id ?? '').trim(), `ops[${i}].id`)
      touch(refs)
      for (const ref of refs) deletes.add(ref)
    } else if (op.op === 'set_style') {
      const where = `ops[${i}]`
      const props = styleProps(op, where)
      let refs: string[]
      let what: string
      let shaped = false // 只有矩形、椭圆、菱形能改填充、形状和大小
      const key = typeof op.id === 'string' ? op.id.trim() : ''
      if (key) {
        requireSettledRef(key, `${where}.id`)
        if (existing.has(key) || byKey.has(key)) {
          const node = oldNode(key, `${where}.id`)
          refs = [node.ref]
          what = `node ${key}`
          shaped = ['rectangle', 'ellipse', 'diamond'].includes(node.kind)
          if (shaped && node.label && (props.shape || props.w || props.h)) relayout.set(node.ref, node.label)
        } else if (notesById.has(key)) {
          refs = [oldText(key, `${where}.id`).ref]
          what = `text ${key}`
        } else if (strokeRefs.has(key)) {
          refs = oldStrokes(key, `${where}.id`)
          what = `hand-drawn strokes ${key}`
        } else {
          throw new OpsError(`${where}.id: unknown id "${key}". Use a node (N1), text (T1) or stroke (S1) id from your latest canvas_read`)
        }
      } else if (op.from && op.to) {
        refs = [oldEdge(String(op.from).trim(), String(op.to).trim(), where).ref]
        what = `the arrow from ${op.from} to ${op.to}`
      } else {
        throw new OpsError(`${where}: set_style needs "id" (a node, text or stroke id), or "from" and "to" for an arrow`)
      }
      if (!shaped && (props.fill || props.shape || props.w || props.h)) {
        throw new OpsError(`${where}: only "color" can be changed on ${what}; fill, shape, width and height work on rectangle, ellipse and diamond nodes`)
      }
      touch(refs)
      for (const ref of refs) styles.set(ref, { ...styles.get(ref), ...props, elementId: ref })
    } else if (op.op === 'move') {
      const where = `ops[${i}]`
      const id = typeof op.id === 'string' ? op.id.trim() : ''
      const target = moveTarget(id, `${where}.id`)
      const position = movePosition(op, where)
      const anchor = position.mode === 'near' && !byKey.has(position.near) ? moveTarget(position.near, `${where}.near`, true) : undefined
      if (anchor?.elementIds.some((ref) => target.elementIds.includes(ref))) throw new OpsError(`${where}: move cannot use its own target as near`)
      for (const ref of target.elementIds) {
        if (movingRefs.has(ref)) throw new OpsError(`${where}: element "${id}" is already moved in this call`)
        movingRefs.add(ref)
        modifiedRefs.add(ref)
      }
      targetGroups.push(target.elementIds)
      moveOps.push({ id, target, anchor, position, where })
    } else if (op.op === 'add_edge') {
      const from = check(String(op.from ?? '').trim(), `ops[${i}].from`)
      const to = check(String(op.to ?? '').trim(), `ops[${i}].to`)
      if (from === to) throw new OpsError(`ops[${i}]: an edge cannot connect a node to itself`)
      edgeOps.push({ from, to, label: cleanLabel(op.label) })
    } else if (op.op === 'add_text') {
      const text = String(op.text ?? '').trim()
      if (!text) throw new OpsError(`ops[${i}]: add_text needs "text"`)
      const placed = isFiniteNumber(op.x) && isFiniteNumber(op.y)
      const near = String(op.near ?? '').trim()
      if (placed && near && !byKey.has(near)) requireSettledRef(near, `ops[${i}].near`)
      textOps.push({
        text,
        near: !placed && near ? check(near, `ops[${i}].near`) : null,
        x: placed ? op.x! : null,
        y: placed ? op.y! : null
      })
    } else if (op.op === 'trace_image') {
      requireSettledRef(String(op.image ?? '').trim(), `ops[${i}].image`)
      traceOps.push({ op, where: `ops[${i}]` })
    } else if (op.op !== 'add_node') {
      throw new OpsError(
        `ops[${i}]: unknown op "${String((op as { op?: unknown }).op)}". Supported: add_node, add_edge, add_text, trace_image, ` +
          'move, update_node, delete_node, update_edge, delete_edge, update_text, delete_text, delete_strokes, set_style'
      )
    }
  })
  // 节点改了形状或大小，里面的文字要重新摆；这一批里已经在改它的字、或者要删它的就不用了
  for (const [ref, label] of relayout) {
    if (deletes.has(ref) || updates.some((u) => u.elementId === ref)) continue
    updates.push({ elementId: ref, textId: newId(), label, relayout: true })
  }
  // 同一批里又删又用同一个节点，说明指令自相矛盾
  for (const e of edgeOps) {
    for (const key of [e.from, e.to]) if (deletedKeys.has(key)) throw new OpsError(`this call deletes node ${key} and also adds an arrow to it`)
  }
  for (const t of textOps) if (t.near && deletedKeys.has(t.near)) throw new OpsError(`this call deletes node ${t.near} and also puts text next to it`)
  for (const { id, target, anchor, where } of moveOps) {
    if (target.elementIds.some((ref) => deletes.has(ref))) throw new OpsError(`${where}: this call deletes element "${id}" and also moves it`)
    if (anchor?.elementIds.some((ref) => deletes.has(ref))) throw new OpsError(`${where}: the near anchor "${anchor.id}" is deleted in this call`)
  }

  const nodeByRef = new Map(graph.nodes.map((node) => [node.ref, node]))
  const nodeShapes = new Map(graph.nodes.map((node) => [node.ref, node.kind]))
  const virtualBoxes = new Map<string, Bbox>()
  const reshapedRefs = new Set<string>()
  const nodeUpdates = new Map(updates.map((update) => [update.elementId, update]))
  for (const node of graph.nodes) {
    if (!['rectangle', 'ellipse', 'diamond'].includes(node.kind) || deletes.has(node.ref)) continue
    const style = styles.get(node.ref)
    const update = nodeUpdates.get(node.ref)
    if (!style && !update) continue
    const next = resizedNodeBox({ ...node.bbox, shape: node.kind }, style, update)
    nodeShapes.set(node.ref, next.shape)
    virtualBoxes.set(node.ref, { x: next.x, y: next.y, w: next.w, h: next.h })
    if (next.shape !== node.kind || next.w !== node.bbox.w || next.h !== node.bbox.h) reshapedRefs.add(node.ref)
  }

  // 合并 N/I 等对同一元素的别名，手绘以整组外接框为常规障碍。
  const groupBoxes = new Map<string, Bbox>()
  const splitStrokeGroups = new Set<string>()
  const currentBox = (target: MoveTarget): Bbox => {
    if (target.elementIds.length === 1) return virtualBoxes.get(target.elementIds[0]) ?? target.bbox
    if (!splitStrokeGroups.has(target.id)) return groupBoxes.get(target.id) ?? target.bbox
    const members = target.elementIds.map((ref) => {
      const member = targetsByRef.get(ref)
      return member ? currentBox(member) : target.bbox
    })
    const x = Math.min(...members.map((box) => box.x))
    const y = Math.min(...members.map((box) => box.y))
    return { x, y, w: Math.max(...members.map((box) => box.x + box.w)) - x, h: Math.max(...members.map((box) => box.y + box.h)) - y }
  }
  const obstacleTargets = targets.filter((target) => target.elementIds.length > 1 || targetsByRef.get(target.elementIds[0]) === target)
  const sceneBoxes = (omitted: ReadonlySet<string>) => obstacleTargets.flatMap((target): { id: string; box: Bbox }[] => {
    const refs = target.elementIds.filter((ref) => !omitted.has(ref))
    if (!refs.length) return []
    if (refs.length === target.elementIds.length && (refs.length === 1 || !splitStrokeGroups.has(target.id))) {
      return [{ id: target.id, box: currentBox(target) }]
    }
    return refs.flatMap((ref) => {
      const member = targetsByRef.get(ref)
      return member ? [{ id: target.id, box: currentBox(member) }] : []
    })
  })
  const lineBoxes = graph.lines.filter((line) => !deletes.has(line.ref)).map((line) => line.bbox)
  const layoutBoxes = [...sceneBoxes(new Set([...deletes, ...movingRefs])).map(({ box }) => box), ...lineBoxes]

  // 挂在新节点旁边的文字：排版时给它留出位置（横排时在节点下方，竖排时在节点右侧）
  const reserved = new Map<string, { w: number; h: number }>()
  for (const t of textOps) {
    if (!t.near || !auto.has(t.near)) continue
    const size = textSize(t.text)
    const r = reserved.get(t.near) ?? { w: 0, h: 0 }
    if (direction === 'right') reserved.set(t.near, { w: Math.max(r.w, size.w), h: r.h + size.h + TEXT_GAP })
    else reserved.set(t.near, { w: Math.max(r.w, size.w + TEXT_GAP), h: r.h + size.h })
  }

  // ---------- 排版：dagre 排自动节点，整块放到已有内容下方 ----------
  const bends = new Map<number, [number, number][]>() // 第几条连线 → dagre 给的中间拐点
  let blockBottom: number | null = null
  let blockLeft = layoutBoxes.length ? Math.min(...layoutBoxes.map((b) => b.x)) : START[0]
  if (auto.size) {
    const g = new dagre.graphlib.Graph({ multigraph: true })
    g.setGraph({ rankdir: direction === 'right' ? 'LR' : 'TB', nodesep: NODE_SEP, ranksep: RANK_SEP })
    g.setDefaultEdgeLabel(() => ({}))
    // dagre 看到的节点是"节点加上给文字留的位置"。两边对称着留，真正的节点放在正中间，
    // 这样同一层的节点中线对齐，连线是平的。
    const slot = (n: PlannedNode) => {
      const r = reserved.get(n.key) ?? { w: 0, h: 0 }
      return direction === 'right'
        ? { width: Math.max(n.w, r.w), height: n.h + r.h * 2 }
        : { width: n.w + r.w * 2, height: Math.max(n.h, r.h) }
    }
    for (const key of auto) g.setNode(key, slot(byKey.get(key)!))
    edgeOps.forEach((e, i) => {
      if (!auto.has(e.from) || !auto.has(e.to)) return
      const size = e.label ? textSize(e.label) : null
      g.setEdge(e.from, e.to, size ? { width: size.w + 16, height: size.h, labelpos: 'c' } : {}, String(i))
    })
    dagre.layout(g)

    // dagre 的坐标是它自己的，先求出整块的范围，再平移到目标位置
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const grow = (x: number, y: number) => {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
    for (const key of auto) {
      const n = g.node(key)
      grow(n.x - n.width / 2, n.y - n.height / 2)
      grow(n.x + n.width / 2, n.y + n.height / 2)
    }
    for (const e of g.edges()) for (const p of g.edge(e).points ?? []) grow(p.x, p.y)

    // 这一块连着已有节点时紧挨着那些节点放，否则在用户的视野里找空位；规则见 placeBlock
    const anchors = [
      ...new Set(
        edgeOps
          .flatMap((e) => (auto.has(e.from) !== auto.has(e.to) ? [existing.get(auto.has(e.from) ? e.to : e.from)] : []))
          .filter((n) => n !== undefined)
      )
    ].map((node) => virtualBoxes.get(node.ref) ?? node.bbox)
    const bottomOfAll = layoutBoxes.length ? Math.max(...layoutBoxes.map((b) => b.y + b.h)) + BLOCK_GAP : START[1]
    // 给手工指定了坐标的新节点也留出位置
    const pinned = nodes.filter((n) => !auto.has(n.key)).map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }))
    const [originX, originY] = placeBlock({ w: maxX - minX, h: maxY - minY }, [...layoutBoxes, ...pinned], {
      anchors,
      direction,
      view: opts.view ?? null,
      fallback: [
        anchors.length ? anchors.reduce((sum, box) => sum + box.x + box.w / 2, 0) / anchors.length - (maxX - minX) / 2 : blockLeft,
        bottomOfAll
      ]
    })
    const shiftX = originX - minX
    const shiftY = originY - minY
    blockLeft = originX
    blockBottom = originY + (maxY - minY)

    for (const key of auto) {
      const n = byKey.get(key)!
      const d = g.node(key)
      n.x = d.x - n.w / 2 + shiftX
      n.y = d.y - n.h / 2 + shiftY
    }
    for (const e of g.edges()) {
      const from = g.node(e.v)
      const to = g.node(e.w)
      const pts = g.edge(e).points ?? []
      // 相邻两层之间的连线画直线；跨层的连线保留 dagre 算的拐点，绕开中间的节点
      if (Math.abs((to.rank ?? 0) - (from.rank ?? 0)) <= 2 || pts.length <= 3) continue
      bends.set(
        Number(e.name),
        pts.slice(1, -1).map((p: { x: number; y: number }): [number, number] => [p.x + shiftX, p.y + shiftY])
      )
    }
  }

  // ---------- 移动：按指令顺序解析，后续 near 与连线能看到已经更新的位置 ----------
  const moves: PlannedMove[] = []
  const moveByRef = new Map<string, PlannedMove>()
  for (const { id, target, anchor, position, where } of moveOps) {
    const fromBbox = currentBox(target)
    let x: number
    let y: number
    let adjusted = false
    if (position.mode === 'near') {
      const anchorBox = anchor ? currentBox(anchor) : byKey.get(position.near)!
      const omitted = new Set([...deletes, ...target.elementIds])
      const obstacles = [...sceneBoxes(omitted).map(({ box }) => box), ...lineBoxes, ...nodes]
      const placed = placeBeside({ w: fromBbox.w, h: fromBbox.h }, anchorBox, position.side, position.gap, obstacles)
      x = placed.x
      y = placed.y
      adjusted = placed.adjusted
    } else if (position.mode === 'absolute') {
      x = position.x
      y = position.y
    } else {
      x = fromBbox.x + position.dx
      y = fromBbox.y + position.dy
    }
    const toBbox = { x, y, w: fromBbox.w, h: fromBbox.h }
    const dx = moveNumber(position.mode === 'relative' ? position.dx : x - fromBbox.x, 'resulting dx', where)
    const dy = moveNumber(position.mode === 'relative' ? position.dy : y - fromBbox.y, 'resulting dy', where)
    moveNumber(x, 'destination x', where)
    moveNumber(y, 'destination y', where)
    const { kind, elementIds } = target
    const targetKey = elementIds[0]
    const move: PlannedMove = {
      id, kind, targetKey, elementIds, dx, dy, fromBbox, toBbox,
      ...(position.mode === 'relative' ? {} : { toTopLeft: { x, y } }),
      ...(adjusted ? { adjusted } : {})
    }
    if (elementIds.length === 1) {
      virtualBoxes.set(targetKey, toBbox)
      if (groupedMemberRefs.has(targetKey)) splitStrokeGroups.add(target.id)
    } else {
      groupBoxes.set(target.id, toBbox)
      for (const ref of elementIds) {
        const member = targetsByRef.get(ref)
        if (!member) continue
        const box = currentBox(member)
        virtualBoxes.set(ref, { ...box, x: box.x + dx, y: box.y + dy })
      }
    }
    moves.push(move)
    for (const ref of elementIds) moveByRef.set(ref, move)
  }
  for (const [i, move] of moves.entries()) {
    const { position, target } = moveOps[i]
    if (position.mode === 'near') continue
    const from = target.bbox
    const atOrigin = (box: Bbox) => box.x <= from.x && box.y <= from.y && box.x + box.w >= from.x + from.w && box.y + box.h >= from.y + from.h
      && (box.w > from.w || box.h > from.h)
    const containers = new Set(obstacleTargets.filter((candidate) => atOrigin(candidate.bbox)).map((candidate) => candidate.id))
    const others = sceneBoxes(new Set([...deletes, ...move.elementIds]))
    const collisions = [...new Set(others.filter(({ id, box }) => !containers.has(id) && overlaps(move.toBbox, box)).map(({ id }) => id))]
    if (collisions.length) move.overlaps = collisions
  }
  const allBoxes = [...sceneBoxes(deletes).map(({ box }) => box), ...lineBoxes]
  if (!auto.size && allBoxes.length) blockLeft = Math.min(...allBoxes.map((box) => box.x))

  // ---------- 连线的起止点 ----------
  const nodeBox = (node: SemanticGraph['nodes'][number]): Box => ({
    ...(virtualBoxes.get(node.ref) ?? node.bbox),
    shape: nodeShapes.get(node.ref) ?? node.kind
  })
  const boxOf = (key: string): { elementId: string; box: Box } => {
    const fresh = byKey.get(key)
    if (fresh) return { elementId: fresh.elementId, box: { x: fresh.x, y: fresh.y, w: fresh.w, h: fresh.h, shape: fresh.shape } }
    const old = existing.get(key)!
    return { elementId: old.ref, box: nodeBox(old) }
  }
  // 连线要绕开的东西：画布上已有的，加上这一批新画的节点
  const edgeObstacles: Bbox[] = [...allBoxes, ...nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }))]
  const edges: PlannedEdge[] = edgeOps.map((e, i) => {
    const from = boxOf(e.from)
    const to = boxOf(e.to)
    return {
      elementId: newId(),
      fromElementId: from.elementId,
      toElementId: to.elementId,
      label: e.label,
      ...routeBetween(from.box, to.box, edgeObstacles, bends.get(i))
    }
  })

  // ---------- 文字 ----------
  const stacked = new Map<string, number>() // 同一个节点旁边已经放了多高（或多宽）的文字
  let looseY = (blockBottom ?? (allBoxes.length ? Math.max(...allBoxes.map((b) => b.y + b.h)) : START[1] - TEXT_GAP * 2)) + TEXT_GAP * 2
  const texts: PlannedText[] = textOps.map((t) => {
    const size = textSize(t.text)
    let x: number
    let y: number
    if (t.x !== null && t.y !== null) {
      x = t.x
      y = t.y
    } else if (t.near) {
      const { box } = boxOf(t.near)
      const used = stacked.get(t.near) ?? 0
      if (direction === 'down' && auto.has(t.near)) {
        x = box.x + box.w + TEXT_GAP
        y = box.y + used
      } else {
        x = box.x + (box.w - size.w) / 2
        y = box.y + box.h + TEXT_GAP + used
      }
      stacked.set(t.near, used + size.h + (direction === 'down' && auto.has(t.near) ? 0 : TEXT_GAP))
    } else {
      x = blockLeft
      y = looseY
      looseY += size.h + TEXT_GAP
    }
    return { elementId: newId(), text: t.text, x, y }
  })

  // ---------- 照图还原：每张图画成一块，放在原图旁边的空位（或叠在原图上） ----------
  const lines: PlannedLine[] = []
  const placedSoFar: Bbox[] = [
    ...nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })),
    ...texts.map((t) => ({ x: t.x, y: t.y, ...textSize(t.text) }))
  ]
  const traceGraph = traceOps.length && moves.length
    ? { ...graph, images: graph.images.map((image) => ({ ...image, bbox: virtualBoxes.get(image.ref) ?? image.bbox })) }
    : graph
  for (const { op, where } of traceOps) {
    const traced = planTrace(op, traceGraph, newId, [...allBoxes, ...placedSoFar], where)
    if (traced.byStableId) stableRefs.add(traced.imageRef)
    else existingRefs.add(traced.imageRef)
    nodes.push(...traced.nodes)
    texts.push(...traced.texts)
    lines.push(...traced.lines)
    placedSoFar.push(traced.block)
  }

  const reroutes: PlannedReroute[] = []
  if (moveByRef.size) {
    const obstacles = [...allBoxes, ...placedSoFar]
    for (const edge of graph.edges) {
      if (deletes.has(edge.ref)) continue
      const raw = rawById.get(edge.ref)
      if (raw && ((raw as SceneElement & { elbowed?: boolean }).elbowed || (
        raw.customData?.flyingdraws?.author !== 'agent' && (raw.points?.length ?? 0) > 2
      ))) continue
      const from = raw ? nodeByRef.get(raw.startBinding?.elementId ?? '') : edge.from && !edge.inferred ? existing.get(edge.from) : undefined
      const to = raw ? nodeByRef.get(raw.endBinding?.elementId ?? '') : edge.to && !edge.inferred ? existing.get(edge.to) : undefined
      if (!from || !to || deletes.has(from.ref) || deletes.has(to.ref)) continue
      const a = moveByRef.get(from.ref)
      const b = moveByRef.get(to.ref)
      if (!a && !b) continue
      if (a && b && a.dx === b.dx && a.dy === b.dy && !reshapedRefs.has(from.ref) && !reshapedRefs.has(to.ref)) continue
      reroutes.push({ arrowId: edge.ref, fromElementId: from.ref, toElementId: to.ref, ...routeBetween(nodeBox(from), nodeBox(to), obstacles) })
    }
  }

  return {
    nodes,
    edges,
    texts,
    ...(lines.length ? { lines } : {}),
    ...(stableRefs.size ? { stableRefs: [...stableRefs] } : {}),
    updates,
    textEdits,
    styles: [...styles.values()],
    deletes: [...deletes],
    moves,
    ...(reroutes.length ? { reroutes } : {}),
    markers: [],
    targetGroups,
    existingRefs: [...existingRefs],
    modifiedRefs: [...modifiedRefs]
  }
}

// ---------- 照图还原（trace_image） ----------

const TRACE_MAX_ELEMENTS = 500
const TRACE_MAX_POINTS = 200
const TRACE_SPACE_MAX = 20000
const TRACE_GAP = 60 // 还原出来的一块和原图之间留多宽
const TRACE_FONT_MIN = 8
const TRACE_FONT_MAX = 120

function planTrace(
  op: TraceImageOp,
  graph: SemanticGraph,
  newId: () => string,
  obstacles: readonly Bbox[],
  where: string
): { imageRef: string; byStableId: boolean; nodes: PlannedNode[]; texts: PlannedText[]; lines: PlannedLine[]; block: Bbox } {
  const key = String(op.image ?? '').trim()
  const image = graph.images.find((img) => img.id === key || img.ref === key)
  if (!image) throw new OpsError(`${where}.image: unknown image "${key}". Use an image id (like I1) from your latest canvas_read`)
  const space = op.space
  const dim = (v: unknown): boolean => isFiniteNumber(v) && v > 0 && v <= TRACE_SPACE_MAX
  if (!space || !dim(space.w) || !dim(space.h)) {
    throw new OpsError(`${where}.space: give the coordinate space you used, e.g. the image's pixel size {"w": 1200, "h": 800}`)
  }
  const elements: TraceElement[] = Array.isArray(op.elements) ? op.elements : []
  if (!elements.length || elements.length > TRACE_MAX_ELEMENTS) {
    throw new OpsError(`${where}.elements: give 1 to ${TRACE_MAX_ELEMENTS} elements (boxes, texts, lines)`)
  }
  const box = image.bbox
  const [ox, oy] =
    op.place === 'over'
      ? [box.x, box.y]
      : placeBlock({ w: box.w, h: box.h }, obstacles, {
          anchors: [box],
          direction: 'right',
          fallback: [box.x + box.w + TRACE_GAP, box.y]
        })
  const sx = box.w / space.w
  const sy = box.h / space.h
  const X = (v: number): number => ox + v * sx
  const Y = (v: number): number => oy + v * sy

  const num = (v: unknown, name: string, at: string): number => {
    if (!isFiniteNumber(v)) throw new OpsError(`${at}: "${name}" must be a number`)
    return v
  }
  const color = (v: unknown, at: string, allowTransparent = false): string | undefined => {
    if (v === undefined || v === null || v === '') return undefined
    if (typeof v !== 'string' || !(COLOR_RE.test(v) || (allowTransparent && v === 'transparent'))) {
      throw new OpsError(`${at}: colors are hex like "#1971c2"${allowTransparent ? ' (fill may also be "transparent")' : ''}`)
    }
    return v.toLowerCase()
  }
  // 字号也在 space 坐标系里，跟着图一起缩放
  const fontSize = (v: unknown, at: string): number | undefined => {
    if (v === undefined || v === null) return undefined
    const size = num(v, 'font_size', at)
    return Math.round(Math.min(TRACE_FONT_MAX, Math.max(TRACE_FONT_MIN, size * sy)))
  }

  const nodes: PlannedNode[] = []
  const texts: PlannedText[] = []
  const lines: PlannedLine[] = []
  const boxIds = new Map<string, string>()
  elements.forEach((el, j) => {
    const at = `${where}.elements[${j}]`
    if (!el || typeof el !== 'object') throw new OpsError(`${at}: expected an object`)
    if (el.kind === 'box') {
      const x = num(el.x, 'x', at)
      const y = num(el.y, 'y', at)
      const w = num(el.w, 'w', at)
      const h = num(el.h, 'h', at)
      if (w <= 0 || h <= 0) throw new OpsError(`${at}: "w" and "h" must be positive`)
      const shape: NodeShape = el.shape ?? 'rectangle'
      if (!['rectangle', 'ellipse', 'diamond'].includes(shape)) throw new OpsError(`${at}: unknown shape "${String(el.shape)}"`)
      const node: PlannedNode = {
        key: `trace:${j}`,
        elementId: newId(),
        shape,
        label: cleanLabel(el.label),
        x: X(x),
        y: Y(y),
        w: Math.max(2, w * sx),
        h: Math.max(2, h * sy),
        traced: true
      }
      const c = color(el.color, at)
      const f = color(el.fill, at, true)
      const fs = fontSize(el.font_size, at) ?? (node.label && node.h < 42 ? Math.round(Math.min(20, Math.max(TRACE_FONT_MIN, node.h * 0.55))) : undefined)
      if (c) node.color = c
      if (f) node.fill = f
      if (fs) node.fontSize = fs
      if (el.id !== undefined && el.id !== null) {
        const id = String(el.id).trim()
        if (!id) throw new OpsError(`${at}: "id" must not be empty`)
        if (boxIds.has(id)) throw new OpsError(`${at}: duplicate box id "${id}"`)
        boxIds.set(id, node.elementId)
      }
      nodes.push(node)
    } else if (el.kind === 'text') {
      const text = String(el.text ?? '').trim()
      if (!text) throw new OpsError(`${at}: a text needs "text"`)
      const t: PlannedText = { elementId: newId(), text, x: X(num(el.x, 'x', at)), y: Y(num(el.y, 'y', at)), traced: true }
      const c = color(el.color, at)
      const fs = fontSize(el.font_size, at)
      if (c) t.color = c
      if (fs) t.fontSize = fs
      texts.push(t)
    } else if ((el as { kind?: unknown }).kind !== 'line') {
      throw new OpsError(`${at}: "kind" must be "box", "text" or "line"`)
    }
  })
  // 线条最后处理：from/to 可以指向排在它后面的方框
  elements.forEach((el, j) => {
    if (el.kind !== 'line') return
    const at = `${where}.elements[${j}]`
    const raw = Array.isArray(el.points) ? el.points : []
    if (raw.length < 2 || raw.length > TRACE_MAX_POINTS) throw new OpsError(`${at}: a line needs 2 to ${TRACE_MAX_POINTS} points`)
    const pts = raw.map((p, k): [number, number] => {
      if (!Array.isArray(p) || p.length !== 2) throw new OpsError(`${at}.points[${k}]: expected [x, y]`)
      return [X(num(p[0], 'x', at)), Y(num(p[1], 'y', at))]
    })
    const arrow = el.arrow ?? 'none'
    if (!['none', 'end', 'start', 'both'].includes(arrow)) throw new OpsError(`${at}: "arrow" must be none, end, start or both`)
    const bind = (v: unknown, name: string): string | undefined => {
      if (v === undefined || v === null || v === '') return undefined
      const id = boxIds.get(String(v).trim())
      if (!id) throw new OpsError(`${at}.${name}: no box with id "${String(v)}" in this trace_image`)
      return id
    }
    const [x0, y0] = pts[0]
    const line: PlannedLine = {
      elementId: newId(),
      x: x0,
      y: y0,
      points: pts.map(([px, py]): [number, number] => [px - x0, py - y0]),
      startArrow: arrow === 'start' || arrow === 'both',
      endArrow: arrow === 'end' || arrow === 'both',
      dashed: el.dashed === true
    }
    const c = color(el.color, at)
    const from = bind(el.from, 'from')
    const to = bind(el.to, 'to')
    if (c) line.color = c
    if (from) line.fromElementId = from
    if (to) line.toElementId = to
    lines.push(line)
  })
  return { imageRef: image.ref, byStableId: image.id !== key, nodes, texts, lines, block: { x: ox, y: oy, w: box.w, h: box.h } }
}

const SHAPE_WORDS: Record<NodeShape, string> = { rectangle: '矩形', ellipse: '椭圆', diamond: '菱形' }
const MARKER_PAD = 10
const clip = (s: string, max = 30): string => (s.length > max ? `${s.slice(0, max)}…` : s)

// 把一份带改动的计划变成"提议"：新增的照常画在提议层上，改动先不执行，
// 每处改动换成一个标记框（围着目标的虚线框加一句说明），真正的改动放进 pending，等用户接受时再做。
// info.box 给出元素现在的位置，info.name 给出给 agent 看的叫法（如"节点「登录」"）。
export function toProposalPlan(
  plan: DrawPlan,
  info: { box: (ref: string) => Bbox | null; name: (refs: string[]) => string },
  newId: () => string
): { plan: DrawPlan; pending: PendingChanges | null } {
  const groups = new Map<string, Set<string>>()
  for (const refs of plan.targetGroups) {
    const key = refs[0]
    if (!key) continue
    const group = groups.get(key) ?? new Set<string>()
    for (const ref of refs) group.add(ref)
    groups.set(key, group)
  }
  const movedByKey = new Map(plan.moves.map((move) => [move.targetKey, move]))
  const markers: PlannedMarker[] = []
  const moveGhosts: PlannedMoveGhost[] = []
  for (const [key, group] of groups) {
    const refs = [...group]
    const move = movedByKey.get(key)
    const boxes = refs.map((ref) => info.box(ref)).filter((b) => b !== null)
    if (!boxes.length && move) boxes.push(move.fromBbox)
    if (!boxes.length) continue
    const x0 = Math.min(...boxes.map((b) => b.x)) - MARKER_PAD
    const y0 = Math.min(...boxes.map((b) => b.y)) - MARKER_PAD
    const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + MARKER_PAD
    const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + MARKER_PAD

    const parts: string[] = []
    const removed = refs.every((ref) => plan.deletes.includes(ref))
    if (removed) {
      parts.push('删除')
    } else {
      const update = plan.updates.find((u) => u.elementId === key && !u.relayout)
      if (update) parts.push(update.label ? `改成「${clip(update.label)}」` : '去掉文字')
      const edit = plan.textEdits.find((t) => t.elementId === key)
      if (edit) parts.push(`改成「${clip(edit.text)}」`)
      const style = plan.styles.find((s) => s.elementId === key)
      if (style) {
        const bits = [
          style.color ? `颜色 ${style.color}` : '',
          style.fill ? `填充 ${style.fill === 'transparent' ? '去掉' : style.fill}` : '',
          style.shape ? `形状 ${SHAPE_WORDS[style.shape]}` : '',
          style.w || style.h ? `大小 ${style.w ?? '不变'}×${style.h ?? '不变'}` : ''
        ].filter(Boolean)
        parts.push(`改样式：${bits.join('、')}`)
      }
    }
    const moveOnly = Boolean(move && !parts.length)
    if (move) parts.push('移走')
    if (!parts.length) continue
    const note = parts.join('，')
    const name = info.name(refs)
    const frameId = newId()
    markers.push({
      frameId,
      noteId: newId(),
      x: x0,
      y: y0,
      w: x1 - x0,
      h: y1 - y0,
      tone: removed ? 'delete' : 'change',
      note,
      targets: refs,
      summary: removed ? `删除${name}` : moveOnly ? `移动${name}` : `把${name}${note}`
    })
    if (move) {
      const { targetKey, elementIds, dx, dy, toBbox } = move
      const quotedName = name.match(/「(.+)」/s)?.[1] ?? ''
      const [firstLine, nextLine] = quotedName.split(/\r\n?|\n/, 2)
      const chars = Array.from(firstLine)
      const ellipsis = chars.length > 8 || nextLine !== undefined ? '…' : ''
      const label = chars.length ? `「${chars.slice(0, 8).join('')}${ellipsis}」` : `${move.id} `
      moveGhosts.push({
        ghostId: newId(), frameId, targetKey, elementIds, dx, dy, ...toBbox,
        label: `${label}移到这里`,
        summary: `移动${name}`
      })
    }
  }
  if (!markers.length) return { plan, pending: null }
  return {
    plan: { ...plan, updates: [], textEdits: [], styles: [], deletes: [], moves: [], reroutes: undefined, markers, ...(moveGhosts.length ? { moveGhosts } : {}) },
    pending: {
      updates: plan.updates,
      textEdits: plan.textEdits,
      styles: plan.styles,
      deletes: plan.deletes,
      ...(moveGhosts.length ? {
        moves: plan.moves,
        reroutes: plan.reroutes,
        moveGhosts: moveGhosts.map(({ ghostId, frameId, targetKey, elementIds, x, y, dx, dy, summary }) => (
          { ghostId, frameId, targetKey, elementIds, x, y, dx, dy, summary }
        ))
      } : {}),
      markers: markers.map(({ frameId, targets, summary }) => ({ frameId, targets, summary }))
    }
  }
}
