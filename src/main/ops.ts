// agent 的绘图指令（ops）→ 一份"绘图计划"：每个新元素的 id、位置、大小都在这里定好。
// 纯函数，不依赖 Electron。页面拿到计划后只负责把它变成 Excalidraw 元素。
//
// 新增：add_node、add_edge、add_text。
// 改动：update_node、delete_node、update_edge、delete_edge、update_text、delete_text、delete_strokes、set_style。
// 改动可以用在任何人画的东西上（用户的、别的 agent 的都行，design.md 12.4）；还在等用户确认的提议除外。
// 排版：这一批里没指定坐标的新节点交给 dagre 排成一块，整块放在已有内容下方；
// 已有元素不会被挪动。
import dagre from '@dagrejs/dagre'
// 带 .ts 后缀：单元测试是用 node 直接跑这些文件的，node 不会自己补后缀
import { exitPoint, type ShapeBox } from './geometry.ts'
import type { Bbox, SemanticGraph } from './semantic'

export type NodeShape = 'rectangle' | 'ellipse' | 'diamond'
export type Direction = 'right' | 'down'

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
  | { op: 'update_node'; id: string; label: string }
  | { op: 'delete_node'; id: string }
  | { op: 'update_edge'; from: string; to: string; label: string }
  | { op: 'delete_edge'; from: string; to: string }
  | { op: 'update_text'; id: string; text: string } // 独立文字（T1 这类编号）
  | { op: 'delete_text'; id: string }
  | { op: 'delete_strokes'; id: string } // 一组手写或一笔手绘（S1 这类编号）
  | ({ op: 'set_style'; id?: string; from?: string; to?: string } & StyleProps) // id 是节点、文字或手绘；from + to 指一条连线

export const MODIFY_OPS = ['update_node', 'delete_node', 'update_edge', 'delete_edge', 'update_text', 'delete_text', 'delete_strokes', 'set_style']

export interface PlannedNode {
  key: string // agent 在 ops 里起的名字
  elementId: string
  shape: NodeShape
  label: string | null
  x: number
  y: number
  w: number
  h: number
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
}

export interface DrawPlan {
  nodes: PlannedNode[]
  edges: PlannedEdge[]
  texts: PlannedText[]
  // 换掉节点里或连线上的文字；textId 是新文字元素的 id。relayout 为 true 表示文字没变，只是节点改了形状或大小，要重新摆一下
  updates: { elementId: string; textId: string; label: string | null; relayout?: boolean }[]
  textEdits: { elementId: string; text: string }[] // 改独立文字的内容
  styles: PlannedStyle[]
  deletes: string[] // 要删的元素（节点、连线、独立文字、手绘笔画）。绑在上面的文字、连着被删节点的 agent 连线由页面一并处理
  markers: PlannedMarker[] // 只有提议里才有：改动先不执行，画一个标记框告诉用户"打算改这里"
  targetGroups: string[][] // 每条改动指令对应的元素。一组手写是好几个元素，要合在一起标记
  existingRefs: string[] // 这批指令引用到的已有元素（Excalidraw id），页面执行前要确认它们还在
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
  markers: { frameId: string; targets: string[]; summary: string }[]
}

// agent 上一次读到的编号 → 现在的编号。
// N1 这类编号按阅读顺序排，画板一变就可能指向别的节点；这里用 agent 读的那个版本的对照表，
// 把指令里的旧编号换成同一个元素现在的编号。元素已经不在了的，记进 gone。
export function rebaseOps(
  ops: readonly DrawOp[],
  base: readonly { id: string; ref: string }[],
  graph: SemanticGraph
): { ops: DrawOp[]; gone: string[] } {
  const fresh = new Set(ops.flatMap((op) => (op.op === 'add_node' ? [String(op.id)] : [])))
  const refOf = new Map(base.map((n) => [n.id, n.ref]))
  // 元素 → 现在的编号。手绘分组里每一笔都指向那一组：只要当时那组的第一笔还在，就认作同一组
  const nowOf = new Map<string, string>()
  for (const n of graph.nodes) nowOf.set(n.ref, n.id)
  for (const n of graph.notes) nowOf.set(n.ref, n.id)
  for (const s of graph.strokes) nowOf.set(s.ref, s.id)
  for (const g of graph.strokeGroups) for (const ref of g.refs) nowOf.set(ref, g.id)
  const gone = new Set<string>()
  const fix = <T>(id: T): T => {
    if (typeof id !== 'string' || fresh.has(id)) return id
    const ref = refOf.get(id)
    if (!ref) return id // 那个版本里没有这个编号：留给 planOps 报"不认识这个节点"
    const now = nowOf.get(ref)
    if (!now) {
      gone.add(id)
      return id
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
      case 'update_node':
      case 'delete_node':
      case 'update_text':
      case 'delete_text':
      case 'delete_strokes':
        return { ...op, id: fix(op.id) }
      case 'set_style':
        return { ...op, id: fix(op.id), from: fix(op.from), to: fix(op.to) }
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
  // 椭圆和菱形里能放字的地方比外接框小，多留一些
  const pad = shape === 'rectangle' ? 1 : shape === 'ellipse' ? 1.4 : 2
  return {
    w: Math.max(NODE_MIN_W, Math.ceil((t.w + 40) * pad)),
    h: Math.max(shape === 'diamond' ? 90 : NODE_H, Math.ceil((t.h + 30) * pad))
  }
}

type Box = ShapeBox
export { exitPoint }

// ---------- 给新画的一块找落笔的位置 ----------

const PLACE_MARGIN = 30 // 新的一块和已有内容之间至少留这么宽
const PLACE_STEP = 40

const overlaps = (a: Bbox, b: Bbox, margin = 0): boolean =>
  a.x < b.x + b.w + margin && a.x + a.w + margin > b.x && a.y < b.y + b.h + margin && a.y + a.h + margin > b.y

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
  const inside = (p: [number, number], o: Bbox) => p[0] >= o.x && p[0] <= o.x + o.w && p[1] >= o.y && p[1] <= o.y + o.h
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

export function planOps(
  ops: readonly DrawOp[],
  graph: SemanticGraph,
  newId: () => string,
  opts: { direction?: Direction; view?: Bbox | null } = {} // view：用户当前看得见的那块画布（画布坐标），没有就不管视野
): DrawPlan {
  if (!Array.isArray(ops) || ops.length === 0) throw new OpsError('ops must be a non-empty array')
  const direction: Direction = opts.direction === 'down' ? 'down' : 'right'

  // 已有节点：agent 用上一次读到的短编号（N1、N2……）引用
  const existing = new Map(graph.nodes.map((n) => [n.id, n]))
  const allBoxes: Bbox[] = [
    ...graph.nodes.map((n) => n.bbox),
    ...graph.notes.map((n) => n.bbox),
    ...graph.strokes.map((s) => s.bbox),
    ...graph.strokeGroups.map((g) => g.bbox),
    ...graph.images.map((i) => i.bbox),
    ...graph.lines.map((l) => l.bbox)
  ]

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
  const check = (key: string, where: string): string => {
    if (byKey.has(key)) return key
    const old = existing.get(key)
    if (old) {
      existingRefs.add(old.ref)
      return key
    }
    throw new OpsError(`${where}: unknown node "${key}". Use an id from an add_node in this call, or a node id (like N1) from your latest canvas_read`)
  }
  const edgeOps: { from: string; to: string; label: string | null }[] = []
  const textOps: { text: string; near: string | null; x: number | null; y: number | null }[] = []

  // 改动和删除：谁画的都能动（用户的、别的 agent 的），只有还在等用户确认的提议不行
  const updates: DrawPlan['updates'] = []
  const textEdits: DrawPlan['textEdits'] = []
  const styles = new Map<string, PlannedStyle>()
  const relayout = new Map<string, string>() // 改了形状或大小的节点 → 它里面的文字（要重新摆）
  const targetGroups: string[][] = []
  const deletes = new Set<string>()
  const modifiedRefs = new Set<string>()
  const deletedKeys = new Set<string>()
  const settled = (item: { proposed: boolean }, what: string, where: string): void => {
    if (item.proposed) throw new OpsError(`${where}: ${what} is part of a proposal the user has not answered yet. Wait for their answer (canvas_wait) first.`)
  }
  const oldNode = (key: string, where: string) => {
    const node = existing.get(key)
    if (!node) {
      throw new OpsError(
        byKey.has(key)
          ? `${where}: "${key}" is being added in this same call; just add it the way you want it`
          : `${where}: unknown node "${key}". Use a node id (like N1) from your latest canvas_read`
      )
    }
    settled(node, `node ${key}`, where)
    return node
  }
  const oldEdge = (from: string, to: string, where: string) => {
    for (const key of [from, to]) if (!existing.has(key)) throw new OpsError(`${where}: unknown node "${key}". Use node ids (like N1) from your latest canvas_read`)
    const edge =
      graph.edges.find((e) => e.from === from && e.to === to) ??
      graph.edges.find((e) => e.directed !== 'forward' && e.from === to && e.to === from) // 没有方向或双向的线，两头反着说也认
    if (!edge) throw new OpsError(`${where}: there is no arrow from ${from} to ${to} on the canvas`)
    settled(edge, `the arrow from ${from} to ${to}`, where)
    return edge
  }
  const notesById = new Map(graph.notes.map((n) => [n.id, n]))
  const oldText = (key: string, where: string) => {
    const note = notesById.get(key)
    if (!note) throw new OpsError(`${where}: unknown text "${key}". Use a text id (like T1) from your latest canvas_read`)
    settled(note, `text ${key}`, where)
    return note
  }
  const strokeRefs = new Map<string, string[]>([
    ...graph.strokeGroups.map((g): [string, string[]] => [g.id, g.refs]),
    ...graph.strokes.map((s): [string, string[]] => [s.id, [s.ref]])
  ])
  const oldStrokes = (key: string, where: string): string[] => {
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
      const node = oldNode(String(op.id ?? ''), `ops[${i}].id`)
      touch([node.ref])
      if (op.op === 'delete_node') {
        deletes.add(node.ref)
        deletedKeys.add(node.id)
      } else {
        updates.push({ elementId: node.ref, textId: newId(), label: cleanLabel(op.label) })
      }
    } else if (op.op === 'update_edge' || op.op === 'delete_edge') {
      const edge = oldEdge(String(op.from ?? ''), String(op.to ?? ''), `ops[${i}]`)
      touch([edge.ref])
      if (op.op === 'delete_edge') deletes.add(edge.ref)
      else updates.push({ elementId: edge.ref, textId: newId(), label: cleanLabel(op.label) })
    } else if (op.op === 'update_text' || op.op === 'delete_text') {
      const note = oldText(String(op.id ?? ''), `ops[${i}].id`)
      touch([note.ref])
      if (op.op === 'delete_text') {
        deletes.add(note.ref)
      } else {
        const text = String(op.text ?? '').trim()
        if (!text) throw new OpsError(`ops[${i}]: update_text needs "text". To remove the text, use delete_text`)
        textEdits.push({ elementId: note.ref, text })
      }
    } else if (op.op === 'delete_strokes') {
      const refs = oldStrokes(String(op.id ?? ''), `ops[${i}].id`)
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
        refs = [oldEdge(String(op.from), String(op.to), where).ref]
        what = `the arrow from ${op.from} to ${op.to}`
      } else {
        throw new OpsError(`${where}: set_style needs "id" (a node, text or stroke id), or "from" and "to" for an arrow`)
      }
      if (!shaped && (props.fill || props.shape || props.w || props.h)) {
        throw new OpsError(`${where}: only "color" can be changed on ${what}; fill, shape, width and height work on rectangle, ellipse and diamond nodes`)
      }
      touch(refs)
      for (const ref of refs) styles.set(ref, { ...styles.get(ref), ...props, elementId: ref })
    } else if (op.op === 'add_edge') {
      const from = check(String(op.from ?? ''), `ops[${i}].from`)
      const to = check(String(op.to ?? ''), `ops[${i}].to`)
      if (from === to) throw new OpsError(`ops[${i}]: an edge cannot connect a node to itself`)
      edgeOps.push({ from, to, label: cleanLabel(op.label) })
    } else if (op.op === 'add_text') {
      const text = String(op.text ?? '').trim()
      if (!text) throw new OpsError(`ops[${i}]: add_text needs "text"`)
      const placed = isFiniteNumber(op.x) && isFiniteNumber(op.y)
      textOps.push({
        text,
        near: !placed && op.near ? check(String(op.near), `ops[${i}].near`) : null,
        x: placed ? op.x! : null,
        y: placed ? op.y! : null
      })
    } else if (op.op !== 'add_node') {
      throw new OpsError(
        `ops[${i}]: unknown op "${String((op as { op?: unknown }).op)}". Supported: add_node, add_edge, add_text, ` +
          'update_node, delete_node, update_edge, delete_edge, update_text, delete_text, delete_strokes, set_style'
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
  let blockLeft = allBoxes.length ? Math.min(...allBoxes.map((b) => b.x)) : START[0]
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
    ]
    const bottomOfAll = allBoxes.length ? Math.max(...allBoxes.map((b) => b.y + b.h)) + BLOCK_GAP : START[1]
    // 给手工指定了坐标的新节点也留出位置
    const pinned = nodes.filter((n) => !auto.has(n.key)).map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }))
    const [originX, originY] = placeBlock({ w: maxX - minX, h: maxY - minY }, [...allBoxes, ...pinned], {
      anchors: anchors.map((n) => n.bbox),
      direction,
      view: opts.view ?? null,
      fallback: [
        anchors.length ? anchors.reduce((sum, n) => sum + n.bbox.x + n.bbox.w / 2, 0) / anchors.length - (maxX - minX) / 2 : blockLeft,
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

  // ---------- 连线的起止点 ----------
  const boxOf = (key: string): { elementId: string; box: Box } => {
    const fresh = byKey.get(key)
    if (fresh) return { elementId: fresh.elementId, box: { x: fresh.x, y: fresh.y, w: fresh.w, h: fresh.h, shape: fresh.shape } }
    const old = existing.get(key)!
    return { elementId: old.ref, box: { ...old.bbox, shape: old.kind } }
  }
  // 连线要绕开的东西：画布上已有的，加上这一批新画的节点
  const edgeObstacles: Bbox[] = [...allBoxes, ...nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }))]
  const edges: PlannedEdge[] = edgeOps.map((e, i) => {
    const from = boxOf(e.from)
    const to = boxOf(e.to)
    let mid = bends.get(i) ?? []
    if (!mid.length) {
      // 直线会压到别的东西时加一个拐点绕过去
      const via = detourPoint(centerOf(from.box), centerOf(to.box), edgeObstacles)
      if (via) mid = [via]
    }
    const [sx, sy] = exitPoint(from.box, ...(mid[0] ?? centerOf(to.box)), EDGE_GAP)
    const [ex, ey] = exitPoint(to.box, ...(mid[mid.length - 1] ?? centerOf(from.box)), EDGE_GAP)
    return {
      elementId: newId(),
      fromElementId: from.elementId,
      toElementId: to.elementId,
      label: e.label,
      x: sx,
      y: sy,
      points: [[sx, sy] as [number, number], ...mid, [ex, ey] as [number, number]].map(([px, py]): [number, number] => [px - sx, py - sy])
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

  return {
    nodes,
    edges,
    texts,
    updates,
    textEdits,
    styles: [...styles.values()],
    deletes: [...deletes],
    markers: [],
    targetGroups,
    existingRefs: [...existingRefs],
    modifiedRefs: [...modifiedRefs]
  }
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
  const seen = new Set<string>()
  const markers: PlannedMarker[] = []
  for (const refs of plan.targetGroups) {
    const key = refs[0]
    if (!key || seen.has(key)) continue
    seen.add(key)
    const boxes = refs.map((ref) => info.box(ref)).filter((b) => b !== null)
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
    if (!parts.length) continue
    const note = parts.join('，')
    const name = info.name(refs)
    markers.push({
      frameId: newId(),
      noteId: newId(),
      x: x0,
      y: y0,
      w: x1 - x0,
      h: y1 - y0,
      tone: removed ? 'delete' : 'change',
      note,
      targets: refs,
      summary: removed ? `删除${name}` : `把${name}${note}`
    })
  }
  if (!markers.length) return { plan, pending: null }
  return {
    plan: { ...plan, updates: [], textEdits: [], styles: [], deletes: [], markers },
    pending: {
      updates: plan.updates,
      textEdits: plan.textEdits,
      styles: plan.styles,
      deletes: plan.deletes,
      markers: markers.map(({ frameId, targets, summary }) => ({ frameId, targets, summary }))
    }
  }
}
