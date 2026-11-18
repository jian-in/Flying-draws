// 读写画布场景的小工具：版本号、截图、可见区域、原图提取。
import { exportToBlob, serializeAsJSON } from '@excalidraw/excalidraw'
import { chooseAdaptiveExportSize, EXPORT_PADDING, MAX_EXPORT_BYTES, nextExportSizeForBytes } from '../exportSize'
import type { SceneArgs, Api, HiddenMap, ViewBox, SceneEl, Loose } from './types'

export const SAVE_DELAY_MS = 600

// 每个元素被改动时 version 会加一（删除也算），求和就能判断画面内容有没有变。
// 光标移动、缩放这类只改 appState 的操作不会触发保存。
export function elementsVersion(elements: SceneArgs[0]): number {
  let sum = 0
  for (const el of elements) sum += el.version
  return sum + elements.length
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export function extractPlacedResults(elements: readonly SceneEl[]): string[] {
  const ids = new Set<string>()
  for (const el of elements) {
    if (el.isDeleted || el.type !== 'image') continue
    const resId = el.customData?.flyingdraws?.result
    if (typeof resId === 'string' && resId) ids.add(resId)
  }
  return [...ids].sort()
}

export function unmaskElements(elements: readonly SceneEl[], hidden: HiddenMap): SceneEl[] {
  if (!hidden.size) return elements as SceneEl[]
  return elements.map((el) => {
    const saved = hidden.get(el.id)
    if (!saved) return el
    // 读快照和存盘时把筛选隐藏掉的元素还原，不动 version，避免污染画板文件
    return { ...el, opacity: saved.opacity, locked: saved.locked }
  })
}

// 从画布当前状态取一份快照：场景 JSON，以及可选的 PNG 截图
// 用户当前看得见、又没被我们的界面挡住的那块画布（画布坐标）。agent 画新内容时优先往这里放。
// 四边按屏幕像素让出工具栏、横幅和底部筛选栏的位置。
export const VIEW_INSET = { top: 130, right: 24, bottom: 80, left: 24 }

export function visibleArea(appState: { scrollX: number; scrollY: number; width: number; height: number; zoom: { value: number } }): ViewBox | null {
  const z = appState.zoom?.value || 1
  const w = (appState.width - VIEW_INSET.left - VIEW_INSET.right) / z
  const h = (appState.height - VIEW_INSET.top - VIEW_INSET.bottom) / z
  if (!(w > 0 && h > 0)) return null
  return { x: -appState.scrollX + VIEW_INSET.left / z, y: -appState.scrollY + VIEW_INSET.top / z, w, h }
}

export function elementBox(el: { x: number; y: number; width: number; height: number; points?: readonly (readonly [number, number])[] }): ViewBox {
  if (Array.isArray(el.points) && el.points.length >= 2) {
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const [px, py] of el.points) {
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
    }
    return { x: el.x + minX, y: el.y + minY, w: maxX - minX, h: maxY - minY }
  }
  const x = el.width < 0 ? el.x + el.width : el.x
  const y = el.height < 0 ? el.y + el.height : el.y
  return { x, y, w: Math.abs(el.width), h: Math.abs(el.height) }
}

export function boxesOverlap(a: ViewBox, b: ViewBox, margin = 0): boolean {
  return a.x < b.x + b.w + margin && a.x + a.w + margin > b.x && a.y < b.y + b.h + margin && a.y + a.h + margin > b.y
}

export async function snapshot(
  api: Api,
  withImage: boolean,
  hidden?: HiddenMap,
  selectionOnly = false,
  onlyIds?: ReadonlySet<string>
): Promise<{ sceneJson: string; pngBase64: string | null; view: ViewBox | null; selectedIds: string[] }> {
  const raw = api.getSceneElements()
  let elements = hidden ? unmaskElements(raw, hidden) : raw
  const appState = api.getAppState()
  const baseSelected = onlyIds
    ? new Set(onlyIds)
    : new Set(Object.entries(appState.selectedElementIds).filter(([, yes]) => yes).map(([id]) => id))
  const selectedIds = selectionOnly ? [...baseSelected] : []
  if (selectionOnly && baseSelected.size) {
    const selected = new Set(baseSelected)
    for (const element of elements) {
      if (!selected.has(element.id)) continue
      const edge = element as Loose
      if (edge.startBinding) selected.add(edge.startBinding.elementId)
      if (edge.endBinding) selected.add(edge.endBinding.elementId)
    }
    // 用户在截图上画圈/加字后只框选了批注本身时，把压在底下的原图一并带上，保证像素换算和视觉上下文完整
    if (!onlyIds) {
      const selectedBoxes = elements.filter((el) => !el.isDeleted && selected.has(el.id)).map((el) => elementBox(el as Loose))
      if (selectedBoxes.length) {
        for (const el of elements) {
          if (el.isDeleted || el.type !== 'image' || selected.has(el.id)) continue
          const imgBox = elementBox(el as Loose)
          if (selectedBoxes.some((sb) => boxesOverlap(sb, imgBox))) selected.add(el.id)
        }
      }
    }
    elements = elements.filter(element => selected.has(element.id) || ((element as Loose).containerId && selected.has((element as Loose).containerId!)))
  }
  const files = api.getFiles()
  const sceneJson = serializeAsJSON(elements, appState, files, 'local')
  let pngBase64: string | null = null
  if (withImage && elements.length > 0) {
    const exportPng = (maxWidthOrHeight: number) =>
      exportToBlob({
        elements,
        appState: { ...appState, exportBackground: true, exportWithDarkMode: false },
        files,
        mimeType: 'image/png',
        maxWidthOrHeight,
        exportPadding: EXPORT_PADDING
      })
    let maxSize = chooseAdaptiveExportSize(elements)
    let blob = await exportPng(maxSize)
    for (let retry = 0; retry < 2; retry += 1) {
      const nextSize = nextExportSizeForBytes(maxSize, blob.size, MAX_EXPORT_BYTES)
      if (nextSize === null) break
      maxSize = nextSize
      blob = await exportPng(maxSize)
    }
    pngBase64 = await blobToBase64(blob)
  }
  return { sceneJson, pngBase64, view: visibleArea(appState), selectedIds }
}

// 画布默认是淡黄的纸色。用户自己换过背景色的画板不动，只把还是默认白底的换掉。
export const PAPER_COLOR = '#fffbe6'

export const paperOr = (color: unknown): string =>
  typeof color === 'string' && color && color.toLowerCase() !== '#ffffff' ? color : PAPER_COLOR

export const USER_BUSY_WAIT_MS = 10_000

export const DEFERRED_NOTICE_MS = 400

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 用户是不是正在画一笔、拖东西或打字。这时候往画布里写东西会打断手上的动作。
// 照图还原时交给模型的原图：长边超过这个尺寸或体积太大就等比缩小，坐标系用实际发出去的尺寸
export const TRACE_MAX_SIDE = 2048

export const TRACE_MAX_BYTES = 4.5 * 1024 * 1024

/** 取出画布上一张图片的原图，必要时缩小并转成 PNG（兼容裁剪 crop、翻转 scale 与 5 MiB 体积上限）。 */

export async function originalImage(api: Api, elementId: string): Promise<{ base64: string; width: number; height: number }> {
  const element = api.getSceneElements().find((el) => el.id === elementId)
  if (!element || element.type !== 'image' || !element.fileId) throw new Error('没找到选中的图片')
  const file = api.getFiles()[element.fileId]
  if (!file?.dataURL) throw new Error('这张图片的数据还没载入，稍等再试')
  const bitmap = new Image()
  bitmap.src = file.dataURL
  await bitmap.decode()
  const imgEl = element as SceneEl & {
    crop?: { x: number; y: number; width: number; height: number } | null
    scale?: readonly [number, number]
  }
  const natW = bitmap.naturalWidth > 0 ? bitmap.naturalWidth : Math.max(1, Math.round(Math.abs(element.width)))
  const natH = bitmap.naturalHeight > 0 ? bitmap.naturalHeight : Math.max(1, Math.round(Math.abs(element.height)))
  const crop = imgEl.crop && imgEl.crop.width > 0 && imgEl.crop.height > 0 ? imgEl.crop : null
  const flipX = Boolean(imgEl.scale && imgEl.scale[0] < 0)
  const flipY = Boolean(imgEl.scale && imgEl.scale[1] < 0)
  const srcW = crop ? crop.width : natW
  const srcH = crop ? crop.height : natH
  const comma = file.dataURL.indexOf(',')
  const raw = comma >= 0 ? file.dataURL.slice(comma + 1) : ''
  const longSide = Math.max(srcW, srcH)
  if (
    !crop &&
    !flipX &&
    !flipY &&
    bitmap.naturalWidth > 0 &&
    bitmap.naturalHeight > 0 &&
    longSide <= TRACE_MAX_SIDE &&
    raw.length * 0.75 <= TRACE_MAX_BYTES &&
    /^data:image\/png;base64,/i.test(file.dataURL)
  ) {
    return { base64: raw, width: srcW, height: srcH }
  }
  // 其余情况统一重绘成 PNG：格式一致，尺寸与字节体积均受控
  let scale = Math.min(1, TRACE_MAX_SIDE / Math.max(1, longSide))
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法处理这张图片')
  for (let retry = 0; retry < 3; retry += 1) {
    canvas.width = Math.max(1, Math.round(srcW * scale))
    canvas.height = Math.max(1, Math.round(srcH * scale))
    context.save()
    context.clearRect(0, 0, canvas.width, canvas.height)
    if (flipX || flipY) {
      context.translate(flipX ? canvas.width : 0, flipY ? canvas.height : 0)
      context.scale(flipX ? -1 : 1, flipY ? -1 : 1)
    }
    if (crop) {
      context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height)
    } else {
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    }
    context.restore()
    const png = canvas.toDataURL('image/png')
    const base64 = png.slice(png.indexOf(',') + 1)
    const approxBytes = Math.ceil(base64.length * 0.75)
    if (approxBytes <= TRACE_MAX_BYTES || retry === 2) {
      return { base64, width: canvas.width, height: canvas.height }
    }
    const ratio = Math.sqrt((TRACE_MAX_BYTES * 0.88) / approxBytes)
    scale = Math.max(0.15, scale * Math.min(0.85, ratio))
  }
  throw new Error('无法导出这张图片')
}

export function userIsBusy(api: Api): boolean {
  const s = api.getAppState() as ReturnType<Api['getAppState']> & {
    cursorButton?: string
    croppingElementId?: string | null
  }
  return Boolean(
    s.newElement ||
      s.multiElement ||
      s.editingTextElement ||
      s.resizingElement ||
      s.selectionElement ||
      s.selectedElementsAreBeingDragged ||
      s.isResizing ||
      s.isRotating ||
      s.cursorButton === 'down' ||
      s.croppingElementId
  )
}

export const BANNER_HEIGHT = 190 // 确认横幅大约占画布顶部这么高（屏幕像素）

// 把视野移到一批元素上，不改缩放。belowBanner 为 true 时把内容往下让一让，别被顶部的横幅挡住。
export function showElements(api: Api, elements: readonly SceneEl[], belowBanner: boolean): void {
  if (!elements.length) return
  const boxes = elements.map((el) => elementBox(el as Loose))
  const minX = Math.min(...boxes.map((b) => b.x))
  const maxX = Math.max(...boxes.map((b) => b.x + b.w))
  const minY = Math.min(...boxes.map((b) => b.y))
  const maxY = Math.max(...boxes.map((b) => b.y + b.h))
  const s = api.getAppState()
  const zoom = s.zoom.value
  // 新内容本来就全在用户眼前（而且没被横幅挡住）就别动视野：画面突然一跳比不动更打扰人
  const seen = visibleArea(s)
  if (seen) {
    const top = belowBanner ? -s.scrollY + (BANNER_HEIGHT + 20) / zoom : seen.y
    if (minX >= seen.x && maxX <= seen.x + seen.w && minY >= top && maxY <= seen.y + seen.h) return
  }
  if (!belowBanner) {
    api.scrollToContent(elements, { fitToContent: false, animate: true })
    return
  }
  // 自己算滚动位置：把内容放在横幅下面那块区域的正中间；内容比那块区域还高时，顶部对齐到横幅下沿
  const room = s.height - BANNER_HEIGHT
  const top = (maxY - minY) * zoom > room - 40 ? BANNER_HEIGHT + 20 : BANNER_HEIGHT + (room - (maxY - minY) * zoom) / 2
  api.updateScene({
    appState: {
      scrollX: s.width / 2 / zoom - (minX + maxX) / 2,
      scrollY: top / zoom - minY
    }
  })
}

// agent 画的东西一律用蓝色，和用户画的区分开。还没确认的提议再加上虚线和半透明。
export const AGENT_COLOR = '#1971c2'

export const PROPOSAL_OPACITY = 55
