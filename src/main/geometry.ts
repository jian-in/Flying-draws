// 主进程排版和页面改样式都要用的几何小工具。纯函数，不依赖别的模块（页面也会打包它）。

export interface ShapeBox {
  x: number
  y: number
  w: number
  h: number
  shape: string // rectangle / ellipse / diamond，其他类型都按矩形算
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
