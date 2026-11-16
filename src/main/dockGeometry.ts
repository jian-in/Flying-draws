// 窗口吸附的几何判断（纯函数，不依赖 Electron 和系统接口，可以单独测试）。
// 这里的矩形都是窗口「看得见的那一圈」，单位是屏幕物理像素。

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type DockSide = 'right' | 'left' // 画布贴在目标窗口的哪一侧

export const SNAP_PX = 32 // 画布的边离目标窗口的边不超过这么远，松手就吸上去
export const MIN_DOCK_W = 420 // 那一侧剩下的宽度不够这么多就不吸，免得挤成一条
const MIN_OVERLAP = 0.3 // 两个窗口上下至少要重叠这么大比例，才算「放在旁边」

// 松手时画布是不是贴着目标窗口的某一侧
export function snapSide(own: Rect, target: Rect, snap = SNAP_PX): DockSide | null {
  const overlap = Math.min(own.y + own.h, target.y + target.h) - Math.max(own.y, target.y)
  if (overlap < Math.min(own.h, target.h) * MIN_OVERLAP) return null
  const toRight = Math.abs(own.x - (target.x + target.w))
  const toLeft = Math.abs(own.x + own.w - target.x)
  if (toRight <= snap && toRight <= toLeft) return 'right'
  if (toLeft <= snap) return 'left'
  return null
}

// 吸上去以后画布该在哪儿、多大：和目标等高、顶边对齐，宽度占满那一侧到屏幕工作区边缘剩下的空间。
// 用户手动调过宽度（width）就用他调的，但不超过剩下的空间。那一侧放不下时返回 null。
export function dockedRect(target: Rect, side: DockSide, work: Rect, opts: { minW?: number; width?: number | null } = {}): Rect | null {
  const minW = opts.minW ?? MIN_DOCK_W
  const avail = side === 'right' ? work.x + work.w - (target.x + target.w) : target.x - work.x
  if (avail < minW) return null
  const w = opts.width ? Math.min(Math.max(opts.width, minW), avail) : avail
  return { x: side === 'right' ? target.x + target.w : target.x - w, y: target.y, w, h: target.h }
}

// 从上到下（窗口叠放顺序）找第一个能吸的目标
export function pickTarget<T extends { rect: Rect }>(
  own: Rect,
  candidates: readonly T[],
  workOf: (rect: Rect) => Rect,
  opts: { snap?: number; minW?: number } = {}
): { target: T; side: DockSide; rect: Rect } | null {
  for (const c of candidates) {
    const side = snapSide(own, c.rect, opts.snap)
    if (!side) continue
    const rect = dockedRect(c.rect, side, workOf(c.rect), { minW: opts.minW })
    if (rect) return { target: c, side, rect }
  }
  return null
}

export const sameRect = (a: Rect | null, b: Rect | null): boolean =>
  Boolean(a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)
