// ~/.flyingdraws/state.json：跨画板的应用级状态（当前画板、深浅色）。
// 几处分别写不同字段，所以一律「读出来合并再写回」，谁也不覆盖别人的字段。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type Theme = 'light' | 'dark'

export interface AppStateFile {
  currentBoard?: string
  theme?: Theme
}

export const isTheme = (v: unknown): v is Theme => v === 'light' || v === 'dark'

export function readAppStateFile(path: string): AppStateFile {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: AppStateFile = {}
    if (typeof raw.currentBoard === 'string') out.currentBoard = raw.currentBoard
    if (isTheme(raw.theme)) out.theme = raw.theme
    return out
  } catch {
    return {}
  }
}

/** 合并写入；没变就不写。返回是否写了。 */
export function patchAppStateFile(path: string, patch: AppStateFile): boolean {
  const prev = readAppStateFile(path)
  const next: AppStateFile = { ...prev, ...patch }
  if (prev.currentBoard === next.currentBoard && prev.theme === next.theme) return false
  mkdirSync(dirname(path), { recursive: true })
  // 先写临时文件再改名：写到一半崩溃也不会留下半截 JSON，把当前画板和深浅色一起丢掉
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(next), 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
  return true
}
