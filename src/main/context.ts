// 主进程各模块共用的状态：主窗口、IPC 守卫、内置 Agent、当前画板、退出标记。
// 只有这里能改这些变量，别的模块通过 set* 函数改。
import { BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { registerAgent } from './agentIpc'
import { createIpcGuard } from './ipcGuard'
import { DEFAULT_BOARD_ID, isValidBoardId } from './boards'
import { HOME, statePath, RENDERER_FILE } from './paths'

export let win: BrowserWindow | null = null
export function setWin(next: BrowserWindow | null): void {
  win = next
}

export const ipc = createIpcGuard(RENDERER_FILE)
export const agent = registerAgent(HOME, () => win, () => currentBoardId, ipc)

// 用户要真正退出（托盘菜单、系统注销/关机、before-quit）时置为 true，关窗口就不再只是藏到后台
export let quitting = false
export function setQuitting(next: boolean): void {
  quitting = next
}

export function readSavedBoardId(): string {
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as { currentBoard?: unknown }
    if (typeof raw.currentBoard === 'string' && isValidBoardId(raw.currentBoard)) return raw.currentBoard
  } catch {}
  return DEFAULT_BOARD_ID
}

export let currentBoardId = readSavedBoardId()
export function setCurrentBoardId(next: string): void {
  currentBoardId = next
}

// 页面通知"就绪"之前，主进程发过去的调用要先等着
export let windowReady: Promise<void> = Promise.resolve()
export function setWindowReady(next: Promise<void>): void {
  windowReady = next
}
