// 自适应截图导出尺寸（纯函数，无 DOM / Electron / Excalidraw 依赖）。

export const EXPORT_MIN_SIZE = 1200
export const EXPORT_BASE_SIZE = 1600
export const EXPORT_MAX_SIZE = 3200
export const EXPORT_PADDING = 24
export const MAX_EXPORT_PIXELS = 4_500_000
export const MAX_EXPORT_BYTES = 900 * 1024
export const MIN_LEGIBLE_TEXT_PX = 14

export interface ExportSizeElement {
  x: number
  y: number
  width: number
  height: number
  type?: string
  isDeleted?: boolean
  fontSize?: number
  text?: string
  points?: readonly (readonly number[])[]
  customData?: Record<string, unknown>
}

export interface SceneMetrics {
  elementCount: number
  freedrawCount: number
  width: number
  height: number
  maxDim: number
  minDim: number
  minFontSize: number | null
}

function isMarkerElement(el: ExportSizeElement): boolean {
  const custom = el.customData as { flyingdraws?: { role?: unknown } } | undefined
  return custom?.flyingdraws?.role === 'marker'
}

export function measureScene(
  elements: readonly ExportSizeElement[],
  exportPadding: number = EXPORT_PADDING
): SceneMetrics {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let elementCount = 0
  let freedrawCount = 0
  let minFontSize: number | null = null

  for (const el of elements) {
    if (el.isDeleted || isMarkerElement(el)) continue
    if (
      !Number.isFinite(el.x) ||
      !Number.isFinite(el.y) ||
      !Number.isFinite(el.width) ||
      !Number.isFinite(el.height)
    ) {
      continue
    }

    let x1 = Math.min(el.x, el.x + el.width)
    let x2 = Math.max(el.x, el.x + el.width)
    let y1 = Math.min(el.y, el.y + el.height)
    let y2 = Math.max(el.y, el.y + el.height)
    // 箭头、线条、手绘的 x/y 是第一个点的位置，不是外接框左上角：往左或往上画时，
    // 实际占的地方在 x/y 的左边或上边，要按各个点算
    if (Array.isArray(el.points) && el.points.length > 0) {
      let px1 = Infinity
      let py1 = Infinity
      let px2 = -Infinity
      let py2 = -Infinity
      for (const p of el.points) {
        const px = p?.[0]
        const py = p?.[1]
        if (typeof px !== 'number' || typeof py !== 'number' || !Number.isFinite(px) || !Number.isFinite(py)) continue
        if (px < px1) px1 = px
        if (px > px2) px2 = px
        if (py < py1) py1 = py
        if (py > py2) py2 = py
      }
      if (px1 <= px2 && py1 <= py2) {
        x1 = el.x + px1
        x2 = el.x + px2
        y1 = el.y + py1
        y2 = el.y + py2
      }
    }

    if (x1 < minX) minX = x1
    if (y1 < minY) minY = y1
    if (x2 > maxX) maxX = x2
    if (y2 > maxY) maxY = y2

    elementCount += 1
    if (el.type === 'freedraw') freedrawCount += 1

    if (
      el.type === 'text' &&
      typeof el.text === 'string' &&
      el.text.trim().length > 0 &&
      typeof el.fontSize === 'number' &&
      Number.isFinite(el.fontSize) &&
      el.fontSize > 0
    ) {
      minFontSize = minFontSize === null ? el.fontSize : Math.min(minFontSize, el.fontSize)
    }
  }

  if (elementCount === 0) {
    return {
      elementCount: 0,
      freedrawCount: 0,
      width: 0,
      height: 0,
      maxDim: 0,
      minDim: 0,
      minFontSize: null
    }
  }

  const pad2 = Math.max(0, exportPadding) * 2
  const width = Math.max(1, maxX - minX + pad2)
  const height = Math.max(1, maxY - minY + pad2)
  return {
    elementCount,
    freedrawCount,
    width,
    height,
    maxDim: Math.max(width, height),
    minDim: Math.min(width, height),
    minFontSize
  }
}

export function chooseAdaptiveExportSize(elements: readonly ExportSizeElement[]): number {
  const stats = measureScene(elements)
  if (stats.elementCount === 0 || stats.maxDim <= 0) return EXPORT_MIN_SIZE

  // Option 1: 稀疏小画布保持紧凑（1200），一般场景以 1600 起步
  const isSparseSmall = stats.maxDim <= 1400 && stats.elementCount < 20 && stats.freedrawCount < 8
  let target = isSparseSmall ? EXPORT_MIN_SIZE : EXPORT_BASE_SIZE

  // 保证最小字号在缩放到 target 后仍保持 ~14px 可读
  if (stats.minFontSize !== null && stats.maxDim > target) {
    const neededForText = Math.ceil(stats.maxDim * (MIN_LEGIBLE_TEXT_PX / stats.minFontSize))
    target = Math.max(target, Math.min(EXPORT_MAX_SIZE, neededForText))
  }

  // 密集手绘或元素很多的大场景按原画布尺寸提档，保证笔画清晰
  if (stats.maxDim > EXPORT_BASE_SIZE && (stats.freedrawCount >= 8 || stats.elementCount >= 40)) {
    target = Math.max(target, Math.min(EXPORT_MAX_SIZE, Math.ceil(stats.maxDim)))
  }

  // Option 2: 总像素预算上限，宽/高长图可到 3200，超大 1:1 画布不炸到 10MP
  const aspect = stats.minDim / stats.maxDim
  const maxByPixels = Math.floor(Math.sqrt(MAX_EXPORT_PIXELS / aspect))

  return Math.max(EXPORT_MIN_SIZE, Math.min(EXPORT_MAX_SIZE, target, maxByPixels))
}

export function nextExportSizeForBytes(
  currentSize: number,
  byteLength: number,
  maxBytes: number = MAX_EXPORT_BYTES
): number | null {
  if (!Number.isFinite(currentSize) || !Number.isFinite(byteLength) || !Number.isFinite(maxBytes)) {
    return null
  }
  if (byteLength <= maxBytes || currentSize <= EXPORT_MIN_SIZE || maxBytes <= 0) {
    return null
  }
  const ratio = Math.min(0.72, Math.sqrt(maxBytes / byteLength) * 0.92)
  const stepped = Math.max(EXPORT_MIN_SIZE, Math.floor(currentSize * ratio))
  return stepped < currentSize ? stepped : EXPORT_MIN_SIZE
}
