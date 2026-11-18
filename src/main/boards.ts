// 画板标识校验、文件名映射与元数据解析（纯函数，不依赖 Electron）
import { join, resolve } from 'node:path'

export const DEFAULT_BOARD_ID = 'default'
export const BOARD_EXT = '.excalidraw'

const INVALID_ID_RE = /[\\/:*?"<>|\x00-\x1f]/
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const MAX_BOARD_ID_LEN = 64
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

export interface BoardMeta {
  board: string
  title: string | null
  version: number
  elements: number
  updatedAt: string
}

export function sameBoardOnDisk(a: string, b: string): boolean {
  return CASE_INSENSITIVE_FS ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function matchExistingBoardId(id: string, existingIds: readonly string[]): string | null {
  if (existingIds.includes(id)) return id
  if (!CASE_INSENSITIVE_FS) return null
  const lower = id.toLowerCase()
  return existingIds.find((x) => x.toLowerCase() === lower) ?? null
}

// 校验已有的画板 ID（不允许空白、路径分隔符、相对路径、Windows 保留设备名或特殊符号）
export function validateBoardId(raw: string): string {
  const id = String(raw ?? '').trim()
  if (!id) throw new Error('画板名称不能为空')
  if (id.length > MAX_BOARD_ID_LEN) throw new Error(`画板名称不能超过 ${MAX_BOARD_ID_LEN} 个字符`)
  if (id === '.' || id === '..' || id.startsWith('.') || id.endsWith('.')) {
    throw new Error(`画板名称不合法：${id}`)
  }
  if (WIN_RESERVED_RE.test(id)) {
    throw new Error(`画板名称不能使用系统保留名：${id}`)
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
  const used = new Set(existingIds.map((x) => (CASE_INSENSITIVE_FS ? x.toLowerCase() : x)))
  for (let i = 1; ; i++) {
    const candidate = `board-${i}`
    if (!used.has(CASE_INSENSITIVE_FS ? candidate.toLowerCase() : candidate)) return candidate
  }
}
