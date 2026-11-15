// agent 的绘图指令（ops）→ 一份"绘图计划"：每个新元素的 id、位置、大小都在这里定好。
// 纯函数，不依赖 Electron。页面拿到计划后只负责把它变成 Excalidraw 元素。
//
// M2-a 只支持纯新增：add_node、add_edge、add_text。位置先用最简单的办法排
// （新节点在已有内容下方排成一行），自动排版留到 M2-b。
import type { Bbox, SemanticGraph } from './semantic'

export type NodeShape = 'rectangle' | 'ellipse' | 'diamond'

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
  dx: number // 终点相对起点的偏移
  dy: number
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
const NODE_GAP = 120 // 同一行里相邻新节点的间距，要放得下带文字的箭头
const ROW_GAP = 100 // 新的一行离已有内容多远
const EDGE_GAP = 8 // 箭头端点离节点边框多远
const TEXT_GAP = 16
const FONT_SIZE = 20
const START: [number, number] = [100, 100] // 空画板上第一个节点的位置

// 估算一段文字的宽度：中日韩文字按一个字号宽，其他按 0.6 个字号。
// 只用来定节点大小，页面里真正的文字尺寸由 Excalidraw 量。
export function estimateTextWidth(text: string): number {
  let longest = 0
  for (const line of text.split('\n')) {
    let w = 0
    for (const ch of line) w += /[⺀-鿿가-힯＀-￯]/.test(ch) ? FONT_SIZE : FONT_SIZE * 0.6
    if (w > longest) longest = w
  }
  return Math.ceil(longest)
}

function nodeSize(shape: NodeShape, label: string | null): { w: number; h: number } {
  const lines = label ? label.split('\n').length : 1
  const textW = label ? estimateTextWidth(label) : 0
  const textH = lines * FONT_SIZE * 1.25
  // 椭圆和菱形里能放字的地方比外接框小，多留一些
  const pad = shape === 'rectangle' ? 1 : shape === 'ellipse' ? 1.4 : 2
  return {
    w: Math.max(NODE_MIN_W, Math.ceil((textW + 40) * pad)),
    h: Math.max(shape === 'diamond' ? 90 : NODE_H, Math.ceil((textH + 30) * pad))
  }
}

// 从框中心朝 (tx, ty) 方向走，走到框边再往外 gap 的那个点
function exitPoint(b: Bbox, tx: number, ty: number, gap: number): [number, number] {
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const dx = tx - cx
  const dy = ty - cy
  const len = Math.hypot(dx, dy)
  if (len === 0) return [cx, cy]
  const scale = Math.min(dx === 0 ? Infinity : b.w / 2 / Math.abs(dx), dy === 0 ? Infinity : b.h / 2 / Math.abs(dy))
  const t = scale + gap / len
  return [cx + dx * t, cy + dy * t]
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

export function planOps(ops: readonly DrawOp[], graph: SemanticGraph, newId: () => string): DrawPlan {
  if (!Array.isArray(ops) || ops.length === 0) throw new OpsError('ops must be a non-empty array')

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
  const left = allBoxes.length ? Math.min(...allBoxes.map((b) => b.x)) : START[0]
  const bottom = allBoxes.length ? Math.max(...allBoxes.map((b) => b.y + b.h)) : null

  // 第一遍：节点
  const nodes: PlannedNode[] = []
  const byKey = new Map<string, PlannedNode>()
  let cursorX = left
  const rowY = bottom === null ? START[1] : bottom + ROW_GAP
  ops.forEach((op, i) => {
    if (op.op !== 'add_node') return
    const key = String(op.id ?? '').trim()
    if (!key) throw new OpsError(`ops[${i}]: add_node needs an "id"`)
    if (existing.has(key)) throw new OpsError(`ops[${i}]: id "${key}" is already a node on the canvas; pick another id for the new node`)
    if (byKey.has(key)) throw new OpsError(`ops[${i}]: duplicate node id "${key}"`)
    const shape: NodeShape = op.shape ?? 'rectangle'
    if (!['rectangle', 'ellipse', 'diamond'].includes(shape)) throw new OpsError(`ops[${i}]: unknown shape "${String(op.shape)}"`)
    const label = typeof op.label === 'string' && op.label.trim() ? op.label.trim() : null
    const { w, h } = nodeSize(shape, label)
    const placed = isFiniteNumber(op.x) && isFiniteNumber(op.y)
    const node: PlannedNode = {
      key,
      elementId: newId(),
      shape,
      label,
      x: placed ? op.x! : cursorX,
      y: placed ? op.y! : rowY,
      w,
      h
    }
    if (!placed) cursorX += w + NODE_GAP
    nodes.push(node)
    byKey.set(key, node)
  })
  // 同一行里高矮不一的节点，按中线对齐
  const rowNodes = nodes.filter((n) => n.y === rowY)
  const rowH = Math.max(0, ...rowNodes.map((n) => n.h))
  for (const n of rowNodes) n.y = rowY + (rowH - n.h) / 2

  const existingRefs = new Set<string>()
  const resolve = (key: string, where: string): { elementId: string; bbox: Bbox } => {
    const fresh = byKey.get(key)
    if (fresh) return { elementId: fresh.elementId, bbox: { x: fresh.x, y: fresh.y, w: fresh.w, h: fresh.h } }
    const old = existing.get(key)
    if (old) {
      existingRefs.add(old.ref)
      return { elementId: old.ref, bbox: old.bbox }
    }
    throw new OpsError(`${where}: unknown node "${key}". Use an id from an add_node in this call, or a node id (like N1) from your latest canvas_read`)
  }

  // 第二遍：连线和文字
  const edges: PlannedEdge[] = []
  const texts: PlannedText[] = []
  let looseTextY = (rowNodes.length ? rowY + rowH : rowY) + TEXT_GAP * 2
  ops.forEach((op, i) => {
    if (op.op === 'add_edge') {
      const from = resolve(String(op.from ?? ''), `ops[${i}].from`)
      const to = resolve(String(op.to ?? ''), `ops[${i}].to`)
      if (from.elementId === to.elementId) throw new OpsError(`ops[${i}]: an edge cannot connect a node to itself`)
      const [fcx, fcy] = [from.bbox.x + from.bbox.w / 2, from.bbox.y + from.bbox.h / 2]
      const [tcx, tcy] = [to.bbox.x + to.bbox.w / 2, to.bbox.y + to.bbox.h / 2]
      const [sx, sy] = exitPoint(from.bbox, tcx, tcy, EDGE_GAP)
      const [ex, ey] = exitPoint(to.bbox, fcx, fcy, EDGE_GAP)
      edges.push({
        elementId: newId(),
        fromElementId: from.elementId,
        toElementId: to.elementId,
        label: typeof op.label === 'string' && op.label.trim() ? op.label.trim() : null,
        x: sx,
        y: sy,
        dx: ex - sx,
        dy: ey - sy
      })
    } else if (op.op === 'add_text') {
      const text = String(op.text ?? '').trim()
      if (!text) throw new OpsError(`ops[${i}]: add_text needs "text"`)
      let x: number
      let y: number
      if (isFiniteNumber(op.x) && isFiniteNumber(op.y)) {
        x = op.x
        y = op.y
      } else if (op.near) {
        const target = resolve(String(op.near), `ops[${i}].near`)
        x = target.bbox.x
        y = target.bbox.y + target.bbox.h + TEXT_GAP
      } else {
        x = left
        y = looseTextY
        looseTextY += text.split('\n').length * FONT_SIZE * 1.25 + TEXT_GAP
      }
      texts.push({ elementId: newId(), text, x, y })
    } else if (op.op !== 'add_node') {
      throw new OpsError(`ops[${i}]: unknown op "${String((op as { op?: unknown }).op)}". Supported: add_node, add_edge, add_text`)
    }
  })

  return { nodes, edges, texts, existingRefs: [...existingRefs] }
}
