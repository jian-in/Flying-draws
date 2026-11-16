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

// 吸上去以后画布该在哪儿、多大：和目标垂直对齐并裁剪在工作区（work）内；
// 默认保留画布当前宽度（ownWidth），若用户手动调过宽度（width）则优先用它，均夹在 [minW, avail] 之间。
// 那一侧放不下或垂直可见高度 <= 0 时返回 null。
export function dockedRect(
  target: Rect,
  side: DockSide,
  work: Rect,
  opts: { minW?: number; width?: number | null; ownWidth?: number | null } = {}
): Rect | null {
  const minW = opts.minW ?? MIN_DOCK_W
  const avail = side === 'right' ? work.x + work.w - (target.x + target.w) : target.x - work.x
  if (avail < minW) return null
  const y = Math.max(target.y, work.y)
  const h = Math.min(target.y + target.h, work.y + work.h) - y
  if (h <= 0) return null
  const preferred = opts.width ?? opts.ownWidth
  const w = preferred != null && preferred > 0 ? Math.min(Math.max(preferred, minW), avail) : avail
  return { x: side === 'right' ? target.x + target.w : target.x - w, y, w, h }
}

// 从上到下（窗口叠放顺序）找第一个能吸的目标
export function pickTarget<T extends { rect: Rect }>(
  own: Rect,
  candidates: readonly T[],
  workOf: (rect: Rect) => Rect,
  opts: { snap?: number; minW?: number; accept?: (target: T, side: DockSide) => boolean } = {}
): { target: T; side: DockSide; rect: Rect } | null {
  for (const c of candidates) {
    const side = snapSide(own, c.rect, opts.snap)
    if (!side) continue
    if (opts.accept && !opts.accept(c, side)) continue
    const rect = dockedRect(c.rect, side, workOf(c.rect), { minW: opts.minW, ownWidth: own.w })
    if (rect) return { target: c, side, rect }
  }
  return null
}

export const sameRect = (a: Rect | null, b: Rect | null): boolean =>
  Boolean(a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)

export const nearRect = (a: Rect | null, b: Rect | null, tol = 2): boolean =>
  Boolean(
    a &&
      b &&
      Math.abs(a.x - b.x) <= tol &&
      Math.abs(a.y - b.y) <= tol &&
      Math.abs(a.w - b.w) <= tol &&
      Math.abs(a.h - b.h) <= tol
  )
