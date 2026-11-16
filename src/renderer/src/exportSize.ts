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

    const x1 = Math.min(el.x, el.x + el.width)
    const x2 = Math.max(el.x, el.x + el.width)
    const y1 = Math.min(el.y, el.y + el.height)
    const y2 = Math.max(el.y, el.y + el.height)

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
