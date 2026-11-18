// 用户在 agent 的提议上改了什么。
// 提议画上去的那一刻记一份底稿（baseline），用户表态时拿当时的画布和底稿比，
// 输出几句中文，告诉 agent 具体改了哪里。纯函数，不依赖 Electron。

export interface DiffElement {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  isDeleted?: boolean
  text?: string
  containerId?: string | null
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
  customData?: { flyingdraws?: { author?: string; layer?: string; proposal?: string; role?: string; agent?: string } } | null
}

interface BaselineItem {
  id: string
  kind: 'node' | 'edge' | 'line' | 'text'
  label: string | null // 节点里或连线上的文字；独立文字就是它自己的内容
  x: number
  y: number
  w: number
  h: number
  from: string | null // 连线两端的元素 id
  to: string | null
}

export interface ProposalBaseline {
  items: BaselineItem[]
  names: Record<string, string> // 提议画上去时，连线端点的叫法（元素 id → 文字），端点后来被删了也还能说清楚
  elementIds: string[] // 当时画布上所有元素的 id，用来认出用户后来新加的东西
}

const MOVE_THRESHOLD = 24 // 中心挪了多远才算"移动了"
const RESIZE_THRESHOLD = 0.25 // 宽或高变了多少比例才算"改了大小"

const alive = (elements: readonly DiffElement[]): DiffElement[] => elements.filter((el) => !el.isDeleted)

// 容器 id → 绑在它里面（或上面）的文字
function boundLabels(elements: readonly DiffElement[]): Map<string, string> {
  const labels = new Map<string, string>()
  for (const el of alive(elements)) {
    if (el.type === 'text' && el.containerId) labels.set(el.containerId, (el.text ?? '').trim())
  }
  return labels
}

function describeName(el: DiffElement | undefined, labels: Map<string, string>): string {
  if (!el) return '（已删除的元素）'
  if (el.type === 'text') return `「${(el.text ?? '').trim()}」`
  const label = labels.get(el.id)
  return label ? `「${label}」` : '一个没有文字的图形'
}

export function captureBaseline(elements: readonly DiffElement[], proposalId: string): ProposalBaseline {
  const live = alive(elements)
  const byId = new Map(live.map((el) => [el.id, el]))
  const labels = boundLabels(live)
  const items: BaselineItem[] = []
  const names: Record<string, string> = {}
  for (const el of live) {
    if (el.customData?.flyingdraws?.proposal !== proposalId) continue
    if (el.customData?.flyingdraws?.role === 'marker') continue // 标记框是改动预览，不算提议里的新元素
    if (el.type === 'text' && el.containerId) continue // 绑在容器上的文字算容器的标签，不单独记
    const kind: BaselineItem['kind'] =
      el.type === 'arrow' ? 'edge' : el.type === 'line' ? 'line' : el.type === 'text' ? 'text' : 'node'
    const from = el.startBinding?.elementId ?? null
    const to = el.endBinding?.elementId ?? null
    for (const end of [from, to]) if (end) names[end] = describeName(byId.get(end), labels)
    items.push({
      id: el.id,
      kind,
      label: kind === 'text' ? (el.text ?? '').trim() : (labels.get(el.id) ?? null),
      x: el.x,
      y: el.y,
      w: Math.abs(el.width),
      h: Math.abs(el.height),
      from,
      to
    })
  }
  return { items, names, elementIds: live.map((el) => el.id) }
}

function moveWords(dx: number, dy: number): string {
  const horiz = Math.abs(dx) >= MOVE_THRESHOLD ? (dx > 0 ? '右' : '左') : ''
  const vert = Math.abs(dy) >= MOVE_THRESHOLD ? (dy > 0 ? '下' : '上') : ''
  return `往${horiz}${vert}挪了`
}

// 返回一组中文句子；用户什么都没改时返回空数组
export function diffProposal(baseline: ProposalBaseline, elementsNow: readonly DiffElement[]): string[] {
  const live = alive(elementsNow)
  const byId = new Map(live.map((el) => [el.id, el]))
  const labels = boundLabels(live)
  const nameOf = (id: string | null): string => {
    if (!id) return '（空白处）'
    const el = byId.get(id)
    return el ? describeName(el, labels) : (baseline.names[id] ?? '（已删除的元素）')
  }
  const quote = (label: string | null, fallback: string): string => (label ? `「${label}」` : fallback)
  const out: string[] = []

  for (const item of baseline.items) {
    const el = byId.get(item.id)
    if (item.kind === 'node') {
      const was = quote(item.label, '一个没有文字的节点')
      if (!el) {
        out.push(`删掉了节点${was}`)
        continue
      }
      const label = labels.get(el.id) ?? null
      if (label !== item.label) out.push(label ? `把节点${was}的文字改成了「${label}」` : `去掉了节点${was}里的文字`)
      const dx = el.x + Math.abs(el.width) / 2 - (item.x + item.w / 2)
      const dy = el.y + Math.abs(el.height) / 2 - (item.y + item.h / 2)
      if (Math.hypot(dx, dy) >= MOVE_THRESHOLD) out.push(`把节点${quote(label, '（无文字）')}${moveWords(dx, dy)}`)
      const grew = (now: number, before: number) => before > 0 && Math.abs(now - before) / before >= RESIZE_THRESHOLD
      if (grew(Math.abs(el.width), item.w) || grew(Math.abs(el.height), item.h)) out.push(`改了节点${quote(label, '（无文字）')}的大小`)
    } else if (item.kind === 'edge') {
      const was = `${baseline.names[item.from ?? ''] ?? nameOf(item.from)} → ${baseline.names[item.to ?? ''] ?? nameOf(item.to)}`
      if (!el) {
        out.push(`删掉了连线 ${was}`)
        continue
      }
      const from = el.startBinding?.elementId ?? null
      const to = el.endBinding?.elementId ?? null
      // 端点的节点被删掉时，连线自然断开，这种情况在"删掉了节点"里已经说了
      const rewired = (now: string | null, before: string | null) => now !== before && (before === null || byId.has(before))
      if (rewired(from, item.from) || rewired(to, item.to)) out.push(`把连线 ${was} 改成了 ${nameOf(from)} → ${nameOf(to)}`)
      const label = labels.get(el.id) ?? null
      if (label !== item.label) {
        out.push(label ? `把连线 ${was} 上的文字${item.label ? `「${item.label}」` : ''}改成了「${label}」` : `去掉了连线 ${was} 上的文字「${item.label}」`)
      }
    } else if (item.kind === 'line') {
      if (!el) {
        out.push('删掉了线条')
        continue
      }
      const dx = el.x - item.x
      const dy = el.y - item.y
      if (Math.hypot(dx, dy) >= MOVE_THRESHOLD) out.push(`把线条${moveWords(dx, dy)}`)
    } else {
      const was = `「${item.label}」`
      if (!el) {
        out.push(`删掉了文字${was}`)
        continue
      }
      const text = (el.text ?? '').trim()
      if (text !== item.label) out.push(`把文字${was}改成了「${text}」`)
      const dx = el.x - item.x
      const dy = el.y - item.y
      if (Math.hypot(dx, dy) >= MOVE_THRESHOLD) out.push(`把文字「${text}」${moveWords(dx, dy)}`)
    }
  }

  // 用户后来自己加的东西：提议画上去时还不存在，也不是 agent 画的
  const known = new Set(baseline.elementIds)
  const added = live.filter((el) => !known.has(el.id) && el.customData?.flyingdraws?.author !== 'agent')
  if (added.length) {
    const parts: string[] = []
    const count = (type: string) => added.filter((el) => el.type === type).length
    for (const el of added) {
      if (['rectangle', 'ellipse', 'diamond'].includes(el.type)) parts.push(`节点${describeName(el, labels)}`)
      else if (el.type === 'text' && !el.containerId) parts.push(`文字「${(el.text ?? '').trim()}」`)
    }
    if (count('arrow')) parts.push(`${count('arrow')} 条连线`)
    if (count('line')) parts.push(`${count('line')} 条线条`)
    if (count('freedraw')) parts.push(`${count('freedraw')} 笔手绘`)
    if (count('image')) parts.push(`${count('image')} 张图片`)
    if (parts.length) out.push(`自己加了：${parts.join('、')}`)
  }
  return out
}
