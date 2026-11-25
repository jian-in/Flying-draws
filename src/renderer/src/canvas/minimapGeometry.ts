// 全局预览小地图的纯几何换算（不依赖 DOM / Electron，便于单元测试）。
import type { ViewBox } from './types'

export interface MinimapElementLike {
  x: number
  y: number
  width: number
  height: number
  /** Excalidraw 的旋转角（弧度，顺时针），缺省为 0 */
  angle?: number
  type?: string
  isDeleted?: boolean
  opacity?: number
  points?: readonly (readonly [number, number])[]
}

export interface MinimapPoint { x: number; y: number }

export interface MinimapTransform {
  world: ViewBox
  scale: number
  offsetX: number
  offsetY: number
  hasElements: boolean
}

// Excalidraw 0.18 只导出整组元素的 getCommonBounds，没有导出单个图元旋转后的轮廓，
// 而且它依赖 DOM，单元测试里引不进来。这里按它的规则自己算：图元绕自身外框中心旋转，
// 线性图元的中心取点集外框中心。外框和预览轮廓都从这几个函数出，保证是同一套世界坐标。
function rotateAround(px: number, py: number, cx: number, cy: number, angle: number): MinimapPoint {
  if (!angle) return { x: px, y: py }
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = px - cx
  const dy = py - cy
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
}

function elementAngle(el: MinimapElementLike): number {
  return typeof el.angle === 'number' && Number.isFinite(el.angle) ? el.angle : 0
}

function boxOfPoints(points: readonly MinimapPoint[]): ViewBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
}

/** 线、箭头、手绘线在世界坐标中的折线点（已按旋转角绕点集外框中心旋转）；不是线性图元时返回 null。 */
export function minimapLinearPoints(el: MinimapElementLike): MinimapPoint[] | null {
  if (!Array.isArray(el.points) || el.points.length < 2) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [px, py] of el.points) {
    if (px < minX) minX = px
    if (px > maxX) maxX = px
    if (py < minY) minY = py
    if (py > maxY) maxY = py
  }
  const cx = el.x + (minX + maxX) / 2
  const cy = el.y + (minY + maxY) / 2
  const angle = elementAngle(el)
  return el.points.map(([px, py]) => rotateAround(el.x + px, el.y + py, cx, cy, angle))
}

/** 非线性图元未旋转时的外框（负宽高已归一）、中心和旋转角。 */
export function minimapShapeFrame(el: MinimapElementLike): ViewBox & { cx: number; cy: number; angle: number } {
  const x = el.width < 0 ? el.x + el.width : el.x
  const y = el.height < 0 ? el.y + el.height : el.y
  const w = Math.abs(el.width)
  const h = Math.abs(el.height)
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2, angle: elementAngle(el) }
}

/** 形状轮廓顶点（世界坐标，已旋转）：菱形取四条边的中点，其余取外框四角。 */
export function minimapShapeOutline(el: MinimapElementLike): MinimapPoint[] {
  const f = minimapShapeFrame(el)
  const corners: [number, number][] = el.type === 'diamond'
    ? [[f.cx, f.y], [f.x + f.w, f.cy], [f.cx, f.y + f.h], [f.x, f.cy]]
    : [[f.x, f.y], [f.x + f.w, f.y], [f.x + f.w, f.y + f.h], [f.x, f.y + f.h]]
  return corners.map(([px, py]) => rotateAround(px, py, f.cx, f.cy, f.angle))
}

/** 图元旋转后在世界坐标中的轴对齐外框，和 Excalidraw 的 getElementBounds 口径一致。 */
export function minimapElementBox(el: MinimapElementLike): ViewBox {
  const linear = minimapLinearPoints(el)
  if (linear) return boxOfPoints(linear)
  const f = minimapShapeFrame(el)
  if (el.type === 'ellipse' && f.angle) {
    // 椭圆旋转后的精确外框，四角外框会偏大
    const rx = f.w / 2
    const ry = f.h / 2
    const cos = Math.cos(f.angle)
    const sin = Math.sin(f.angle)
    const hw = Math.hypot(rx * cos, ry * sin)
    const hh = Math.hypot(rx * sin, ry * cos)
    return { x: f.cx - hw, y: f.cy - hh, w: Math.max(1, hw * 2), h: Math.max(1, hh * 2) }
  }
  if (!f.angle) return { x: f.x, y: f.y, w: Math.max(1, f.w), h: Math.max(1, f.h) }
  return boxOfPoints(minimapShapeOutline(el))
}

/** Excalidraw 当前完整视口在画布世界坐标系中的矩形。 */
export function fullViewportBox(appState: {
  scrollX: number
  scrollY: number
  width: number
  height: number
  zoom: { value: number }
}): ViewBox | null {
  const z = appState.zoom?.value || 1
  const w = appState.width / z
  const h = appState.height / z
  if (!(w > 0 && h > 0)) return null
  return { x: -appState.scrollX, y: -appState.scrollY, w, h }
}

/**
 * 计算从画布世界坐标到小地图局部像素坐标的等比映射。
 * 会同时包住全部可见元素与当前视口，保证平移到远处也能看到全貌与自身位置。
 */
export function computeMinimapTransform(
  elements: readonly MinimapElementLike[],
  viewport: ViewBox | null,
  mapWidth: number,
  mapHeight: number,
  padding = 10
): MinimapTransform {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let hasElements = false

  for (const el of elements) {
    if (el.isDeleted || (typeof el.opacity === 'number' && el.opacity <= 0)) continue
    const b = minimapElementBox(el)
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue
    hasElements = true
    if (b.x < minX) minX = b.x
    if (b.y < minY) minY = b.y
    if (b.x + b.w > maxX) maxX = b.x + b.w
    if (b.y + b.h > maxY) maxY = b.y + b.h
  }

  if (viewport) {
    if (viewport.x < minX) minX = viewport.x
    if (viewport.y < minY) minY = viewport.y
    if (viewport.x + viewport.w > maxX) maxX = viewport.x + viewport.w
    if (viewport.y + viewport.h > maxY) maxY = viewport.y + viewport.h
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    minX = 0
    minY = 0
    maxX = 1200
    maxY = 800
  }

  const rawW = Math.max(100, maxX - minX)
  const rawH = Math.max(80, maxY - minY)
  const marginX = rawW * 0.08
  const marginY = rawH * 0.08
  const world: ViewBox = {
    x: minX - marginX,
    y: minY - marginY,
    w: rawW + marginX * 2,
    h: rawH + marginY * 2
  }

  const innerW = Math.max(16, mapWidth - padding * 2)
  const innerH = Math.max(16, mapHeight - padding * 2)
  const scale = Math.min(innerW / world.w, innerH / world.h)
  const drawnW = world.w * scale
  const drawnH = world.h * scale
  const offsetX = padding + (innerW - drawnW) / 2
  const offsetY = padding + (innerH - drawnH) / 2

  return { world, scale, offsetX, offsetY, hasElements }
}

export function worldToMinimap(wx: number, wy: number, t: MinimapTransform): { x: number; y: number } {
  return {
    x: t.offsetX + (wx - t.world.x) * t.scale,
    y: t.offsetY + (wy - t.world.y) * t.scale
  }
}

export function minimapToWorld(mx: number, my: number, t: MinimapTransform): { x: number; y: number } {
  return {
    x: t.world.x + (mx - t.offsetX) / t.scale,
    y: t.world.y + (my - t.offsetY) / t.scale
  }
}

/** 把画布视口中心对准给定世界坐标所需的 scrollX / scrollY。 */
export function scrollForWorldCenter(
  wx: number,
  wy: number,
  appState: { width: number; height: number; zoom: { value: number } }
): { scrollX: number; scrollY: number } {
  const z = appState.zoom?.value || 1
  return {
    scrollX: appState.width / (2 * z) - wx,
    scrollY: appState.height / (2 * z) - wy
  }
}

export const AGENT_WIDTH_DEFAULT = 390
export const AGENT_WIDTH_MIN = 320
export const AGENT_WIDTH_MAX = 760

export function clampAgentWidth(width: number, viewportWidth?: number): number {
  const numeric = Number.isFinite(width) ? Math.round(width) : AGENT_WIDTH_DEFAULT
  const cap = typeof viewportWidth === 'number' && viewportWidth > 0
    ? Math.max(AGENT_WIDTH_MIN, Math.min(AGENT_WIDTH_MAX, Math.round(viewportWidth * 0.65)))
    : AGENT_WIDTH_MAX
  return Math.max(AGENT_WIDTH_MIN, Math.min(cap, numeric))
}
