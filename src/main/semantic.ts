// 语义层 v1：把 Excalidraw 场景翻译成 agent 好读的结构和文字描述。
// 纯函数，不依赖 Electron，可以直接用 node --test 测试。

export interface Bbox {
  x: number
  y: number
  w: number
  h: number
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
  containerId?: string | null
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
  startArrowhead?: string | null
  endArrowhead?: string | null
  points?: readonly (readonly [number, number])[]
  groupIds?: readonly string[]
  frameId?: string | null
  name?: string | null
}

export interface SemanticNode {
  id: string // 给 agent 看的短编号：N1、N2……
  ref: string // Excalidraw 元素 id
  kind: string
  label: string | null
  bbox: Bbox
}

export interface SemanticEdge {
  ref: string
  from: string | null // 节点短编号；没连上任何节点时为 null
  to: string | null
  label: string | null
  directed: 'forward' | 'both' | 'none'
  inferred: boolean // true 表示箭头端点没有真正绑定，是按距离猜的
}

export interface SemanticNote {
  ref: string
  text: string
  attachedTo: { kind: 'node' | 'edge'; id: string } | null
  position: string | null // 相对位置，如"下方"
  bbox: Bbox
}

export interface SemanticStroke {
  ref: string
  shape: 'loop' | 'straight' | 'curve'
  bbox: Bbox
  encloses: string[] // 被圈住的节点短编号或旁注文字
  near: { id: string; position: string } | null
}

export interface SemanticGraph {
  nodes: SemanticNode[]
  edges: SemanticEdge[]
  notes: SemanticNote[]
  strokes: SemanticStroke[]
  containment: { parent: string; child: string }[]
  images: { ref: string; bbox: Bbox }[]
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

function bboxOf(el: SceneElement): Bbox {
  // 线条和箭头的宽高可能是负的，统一成左上角加正宽高
  const x = el.width < 0 ? el.x + el.width : el.x
  const y = el.height < 0 ? el.y + el.height : el.y
  return { x, y, w: Math.abs(el.width), h: Math.abs(el.height) }
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

export function buildGraph(rawElements: readonly SceneElement[]): SemanticGraph {
  const elements = rawElements.filter((el) => !el.isDeleted)
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
    bbox: bboxOf(el)
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
    edges.push({ ref: el.id, from, to, label: boundText.get(el.id) ?? null, directed, inferred })
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
      ref: el.id,
      text: (el.text ?? '').trim(),
      attachedTo: best,
      position: bestBox ? relativePosition(b, bestBox) : null,
      bbox: b
    })
  }

  // 手绘笔画
  const strokes: SemanticStroke[] = []
  for (const el of elements) {
    if (el.type !== 'freedraw') continue
    const b = bboxOf(el)
    if (Math.hypot(b.w, b.h) < MIN_STROKE_SIZE) continue
    const shape = classifyStroke(el)
    const encloses: string[] = []
    if (shape === 'loop') {
      for (const n of nodes) if (contains(b, n.bbox, 8)) encloses.push(n.id)
      for (const note of notes) if (contains(b, note.bbox, 8)) encloses.push(`"${note.text}"`)
    }
    let near: SemanticStroke['near'] = null
    let bestD = Infinity
    for (const n of nodes) {
      if (encloses.includes(n.id) || n.kind === 'frame' || n.kind === 'magicframe') continue
      const d = bboxDistance(b, n.bbox)
      if (d < bestD) {
        bestD = d
        near = { id: n.id, position: relativePosition(b, n.bbox) }
      }
    }
    strokes.push({ ref: el.id, shape, bbox: b, encloses, near })
  }

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

  const images = elements.filter((el) => el.type === 'image').map((el) => ({ ref: el.id, bbox: bboxOf(el) }))
  const lines = elements.filter((el) => el.type === 'line').map((el) => ({ ref: el.id, bbox: bboxOf(el) }))
  const needsImage =
    images.length > 0 ||
    lines.length > 0 ||
    strokes.length > MAX_LISTED_STROKES ||
    strokes.some((s) => s.shape === 'curve')

  return { nodes, edges, notes, strokes, containment, images, lines, needsImage }
}

function nodeName(nodes: Map<string, SemanticNode>, id: string | null): string {
  if (!id) return '（空白处）'
  const n = nodes.get(id)
  if (!n) return id
  return n.label ? `${n.id}「${n.label}」` : `${n.id}（无文字${KIND_NAMES[n.kind] ?? n.kind}）`
}

export function summarize(graph: SemanticGraph, meta: { board: string; version: number }): string {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
  const edgeByRef = new Map(graph.edges.map((e) => [e.ref, e]))
  const counts = [
    `${graph.nodes.length} 个节点`,
    `${graph.edges.length} 条连线`,
    graph.notes.length ? `${graph.notes.length} 段文字` : '',
    graph.strokes.length ? `${graph.strokes.length} 笔手绘` : '',
    graph.images.length ? `${graph.images.length} 张图片` : '',
    graph.lines.length ? `${graph.lines.length} 条线条` : ''
  ].filter(Boolean)
  const out: string[] = [`画板「${meta.board}」v${meta.version}：${counts.join('，')}`]

  if (graph.nodes.length === 0 && graph.notes.length === 0 && graph.strokes.length === 0 && graph.images.length === 0) {
    out.push('（画板是空的）')
    return out.join('\n')
  }

  if (graph.nodes.length) {
    out.push('节点：')
    const parentOf = new Map(graph.containment.map((c) => [c.child, c.parent]))
    for (const n of graph.nodes) {
      const kind = KIND_NAMES[n.kind] ?? n.kind
      const parent = parentOf.get(n.id)
      out.push(`  ${n.id} ${n.label ? `「${n.label}」` : '（无文字）'}${kind}${parent ? `，在 ${nodeName(nodes, parent)} 里面` : ''}`)
    }
  }

  if (graph.edges.length) {
    out.push('连线：')
    for (const e of graph.edges) {
      const arrow = e.directed === 'both' ? '↔' : e.directed === 'none' ? '—' : '→'
      const label = e.label ? `，标着「${e.label}」` : ''
      const guess = e.inferred ? '（端点没有吸附，按距离推测）' : ''
      out.push(`  ${nodeName(nodes, e.from)} ${arrow} ${nodeName(nodes, e.to)}${label}${guess}`)
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
      out.push(`  「${note.text}」${where}`)
    }
  }

  if (graph.strokes.length) {
    out.push('手绘：')
    const shapeName = { loop: '一个圈', straight: '一条直线', curve: '一条曲线或涂鸦' }
    for (const s of graph.strokes.slice(0, MAX_LISTED_STROKES)) {
      const parts = [shapeName[s.shape]]
      if (s.encloses.length) parts.push(`圈住了 ${s.encloses.map((id) => (nodes.has(id) ? nodeName(nodes, id) : id)).join('、')}`)
      if (s.near) parts.push(`在 ${nodeName(nodes, s.near.id)} ${s.near.position}`)
      out.push(`  ${parts.join('，')}`)
    }
    const rest = graph.strokes.length - MAX_LISTED_STROKES
    if (rest > 0) out.push(`  ……另有 ${rest} 笔，请看附图`)
  }

  if (graph.images.length) out.push(`图片：${graph.images.length} 张（内容请看附图）`)
  if (graph.lines.length) out.push(`线条：${graph.lines.length} 条没有箭头的折线（形状请看附图）`)
  return out.join('\n')
}
