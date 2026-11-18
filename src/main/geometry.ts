// 主进程排版和页面改样式都要用的几何小工具。纯函数，不依赖别的模块（页面也会打包它）。

export interface ShapeBox {
  x: number
  y: number
  w: number
  h: number
  shape: string // rectangle / ellipse / diamond，其他类型都按矩形算
}

export type BoxShape = 'rectangle' | 'ellipse' | 'diamond'

// 椭圆和菱形里能放字的内切区域比外接框小，留白系数与 ops.ts 保持一致
export const TEXT_PAD: Record<BoxShape, number> = {
  rectangle: 1,
  ellipse: 1.4,
  diamond: 2
}

// update_node 自动扩宽时，单行文字测量宽度上限（超出部分交给 Excalidraw 自动折行撑高）
export const AUTO_TEXT_MAX_W = 320

export function containerWidthFor(shape: string, textW: number, minW = 120): number {
  const pad = TEXT_PAD[shape as BoxShape] ?? 1
  return Math.max(minW, Math.ceil((textW + 40) * pad))
}

export function containerHeightFor(shape: string, textH: number, minH = 60): number {
  const pad = TEXT_PAD[shape as BoxShape] ?? 1
  return Math.max(shape === 'diamond' ? 90 : minH, Math.ceil((textH + 30) * pad))
}

// 折线/箭头标签的目标中心点：奇数个顶点取正中间顶点，偶数个顶点取中间线段的中点
export function polylineMidpoint(x: number, y: number, points: readonly (readonly [number, number])[]): [number, number] {
  if (!points.length) return [x, y]
  if (points.length === 1) return [x + points[0][0], y + points[0][1]]
  if (points.length % 2 === 1) {
    const mid = points[(points.length - 1) >> 1]
    return [x + mid[0], y + mid[1]]
  }
  const i = (points.length >> 1) - 1
  const a = points[i]
  const b = points[i + 1]
  return [x + (a[0] + b[0]) / 2, y + (a[1] + b[1]) / 2]
}

// 从图形中心朝 (tx, ty) 方向走，走到图形轮廓再往外 gap 的那个点
export function exitPoint(b: ShapeBox, tx: number, ty: number, gap: number): [number, number] {
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
