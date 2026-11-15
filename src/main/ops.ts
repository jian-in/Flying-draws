// agent 的绘图指令（ops）→ 一份"绘图计划"：每个新元素的 id、位置、大小都在这里定好。
// 纯函数，不依赖 Electron。页面拿到计划后只负责把它变成 Excalidraw 元素。
//
// 目前只支持纯新增：add_node、add_edge、add_text。
// 排版：这一批里没指定坐标的新节点交给 dagre 排成一块，整块放在已有内容下方；
// 已有元素一律不动。
import dagre from '@dagrejs/dagre'
import type { Bbox, SemanticGraph } from './semantic'

export type NodeShape = 'rectangle' | 'ellipse' | 'diamond'
export type Direction = 'right' | 'down'

export type DrawOp =
  | { op: 'add_node'; id: string; label?: string; shape?: NodeShape; x?: number; y?: number }
  | { op: 'add_edge'; from: string; to: string; label?: string }
  | { op: 'add_text'; text: string; near?: string; x?: number; y?: number }

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
  existingRefs: string[] // 这批指令引用到的已有元素（Excalidraw id），页面执行前要确认它们还在
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

interface Box extends Bbox {
  shape: string // rectangle / ellipse / diamond，其他类型都按矩形算
}

// 从图形中心朝 (tx, ty) 方向走，走到图形轮廓再往外 gap 的那个点
export function exitPoint(b: Box, tx: number, ty: number, gap: number): [number, number] {
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const dx = tx - cx
  const dy = ty - cy
  const len = Math.hypot(dx, dy)
  if (len === 0) return [cx, cy]
  const a = b.w / 2
  const c = b.h / 2
  let t: number // 中心到轮廓的距离占 (dx, dy) 的比例
  if (b.shape === 'ellipse') t = 1 / Math.hypot(dx / a, dy / c)
  else if (b.shape === 'diamond') t = 1 / (Math.abs(dx) / a + Math.abs(dy) / c)
  else t = Math.min(dx === 0 ? Infinity : a / Math.abs(dx), dy === 0 ? Infinity : c / Math.abs(dy))
  t += gap / len
  return [cx + dx * t, cy + dy * t]
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

export function planOps(
  ops: readonly DrawOp[],
  graph: SemanticGraph,
  newId: () => string,
  opts: { direction?: Direction } = {}
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
  ops.forEach((op, i) => {
    if (op.op === 'add_edge') {
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
      throw new OpsError(`ops[${i}]: unknown op "${String((op as { op?: unknown }).op)}". Supported: add_node, add_edge, add_text`)
    }
  })

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

    // 这一块连着已有节点时，横向对齐到那些节点的正下方；否则贴着已有内容的左边
    const anchors = edgeOps
      .flatMap((e) => (auto.has(e.from) !== auto.has(e.to) ? [existing.get(auto.has(e.from) ? e.to : e.from)] : []))
      .filter((n) => n !== undefined)
    let originX = blockLeft
    if (anchors.length) {
      const cx = anchors.reduce((sum, n) => sum + n.bbox.x + n.bbox.w / 2, 0) / anchors.length
      originX = cx - (maxX - minX) / 2
    }
    const originY = allBoxes.length ? Math.max(...allBoxes.map((b) => b.y + b.h)) + BLOCK_GAP : START[1]
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
  const edges: PlannedEdge[] = edgeOps.map((e, i) => {
    const from = boxOf(e.from)
    const to = boxOf(e.to)
    const mid = bends.get(i) ?? []
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

  return { nodes, edges, texts, existingRefs: [...existingRefs] }
}
