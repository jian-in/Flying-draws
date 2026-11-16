// 画板标识校验、文件名映射与元数据解析（纯函数，不依赖 Electron）
import { join, resolve } from 'node:path'

export const DEFAULT_BOARD_ID = 'default'
export const BOARD_EXT = '.excalidraw'

const INVALID_ID_RE = /[\\/:*?"<>|\x00-\x1f]/
const MAX_BOARD_ID_LEN = 64

export interface BoardMeta {
  board: string
  title: string | null
  version: number
  elements: number
  updatedAt: string
}

// 校验已有的画板 ID（不允许空白、路径分隔符、相对路径或特殊符号）
export function validateBoardId(raw: string): string {
  const id = String(raw ?? '').trim()
  if (!id) throw new Error('画板名称不能为空')
  if (id.length > MAX_BOARD_ID_LEN) throw new Error(`画板名称不能超过 ${MAX_BOARD_ID_LEN} 个字符`)
  if (id === '.' || id === '..' || id.startsWith('.') || id.endsWith('.')) {
    throw new Error(`画板名称不合法：${id}`)
  }
  if (INVALID_ID_RE.test(id) || /\s/.test(id)) {
    throw new Error(`画板名称不能包含空格或特殊字符（\\ / : * ? " < > |）：${id}`)
  }
  return id
}

// 规范化用户或 agent 输入的画板名称：去首尾空白，中间空白折成连字符再校验
export function normalizeBoardId(raw: string): string {
  const collapsed = String(raw ?? '').trim().replace(/\s+/g, '-')
  return validateBoardId(collapsed)
}

export function isValidBoardId(raw: string): boolean {
  try {
    validateBoardId(raw)
    return true
  } catch {
    return false
  }
}

export function boardFilePath(boardsDir: string, rawId: string): string {
  const id = validateBoardId(rawId)
  const root = resolve(boardsDir)
  const target = resolve(join(root, `${id}${BOARD_EXT}`))
  if (resolve(target, '..') !== root) throw new Error(`画板路径越界：${id}`)
  return target
}

export function normalizeBoardTitle(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

export function emptyBoardScene(opts?: { title?: string | null }): Record<string, unknown> {
  const title = normalizeBoardTitle(opts?.title)
  return {
    type: 'excalidraw',
    version: 2,
    source: 'flyingdraws',
    elements: [],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
    flyingdraws: {
      version: 1,
      ...(title ? { title } : {})
    }
  }
}

// 项目原来叫 Sketchlink，旧画板里的标记都挂在这个名字下面
const LEGACY_KEY = 'sketchlink'

// 把旧画板升级成现在的格式：画板自己的元数据和每个元素上的作者标记，都从旧名字挪到 flyingdraws 下面。
// 已经是新格式的原样返回；读不懂的内容也原样返回，交给后面的代码按原来的方式报错。
export function upgradeLegacyScene(sceneJson: string): string {
  if (!sceneJson.includes(`"${LEGACY_KEY}"`)) return sceneJson
  let scene: Record<string, unknown>
  try {
    scene = JSON.parse(sceneJson) as Record<string, unknown>
  } catch {
    return sceneJson
  }
  if (!scene || typeof scene !== 'object') return sceneJson
  const move = (holder: Record<string, unknown>): void => {
    if (!(LEGACY_KEY in holder)) return
    if (!('flyingdraws' in holder)) holder.flyingdraws = holder[LEGACY_KEY]
    delete holder[LEGACY_KEY]
  }
  move(scene)
  if (scene.source === LEGACY_KEY) scene.source = 'flyingdraws'
  if (Array.isArray(scene.elements)) {
    for (const el of scene.elements as { customData?: unknown }[]) {
      if (el?.customData && typeof el.customData === 'object') move(el.customData as Record<string, unknown>)
    }
  }
  return JSON.stringify(scene)
}

export function updateBoardSceneTitle(sceneJson: string, title: string | null): string {
  const scene = JSON.parse(sceneJson) as { flyingdraws?: Record<string, unknown>; [key: string]: unknown }
  const cleanTitle = normalizeBoardTitle(title)
  const prev = scene.flyingdraws && typeof scene.flyingdraws === 'object' ? { ...scene.flyingdraws } : {}
  const version = Number(prev.version) || 1
  delete prev.title
  scene.flyingdraws = { ...prev, version, ...(cleanTitle ? { title: cleanTitle } : {}) }
  return JSON.stringify(scene)
}

export function parseBoardMeta(id: string, json: string, updatedAt: string): BoardMeta {
  try {
    const scene = JSON.parse(json) as {
      elements?: { isDeleted?: boolean }[]
      flyingdraws?: { version?: unknown; title?: unknown }
    }
    const elements = Array.isArray(scene.elements) ? scene.elements.filter((el) => !el?.isDeleted).length : 0
    const version = Number(scene?.flyingdraws?.version) || 1
    const title = normalizeBoardTitle(scene?.flyingdraws?.title)
    return { board: id, title, version, elements, updatedAt }
  } catch {
    return { board: id, title: null, version: 1, elements: 0, updatedAt }
  }
}

export function pickFallbackBoard(remaining: readonly { board: string }[], preferred = DEFAULT_BOARD_ID): string | null {
  if (!remaining.length) return null
  if (remaining.some((b) => b.board === preferred)) return preferred
  return remaining[0].board
}

export function suggestBoardId(existingIds: readonly string[]): string {
  const used = new Set(existingIds)
  for (let i = 1; ; i++) {
    const candidate = `board-${i}`
    if (!used.has(candidate)) return candidate
  }
}
