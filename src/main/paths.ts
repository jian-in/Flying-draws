// 数据目录、文件路径和几个全局常量。
import { app } from 'electron'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { LibraryStore } from './library'

// 设了 FLYINGDRAWS_HOME 就把画板、连接信息和 Electron 自己的数据都放到那个目录下。
// 测试用它开一个和用户画板完全隔离的实例（单实例锁也是按 userData 目录算的）。
export const HOME = resolve(process.env['FLYINGDRAWS_HOME'] || join(homedir(), '.flyingdraws'))
if (process.env['FLYINGDRAWS_HOME']) app.setPath('userData', join(HOME, 'electron-data'))
// 端到端测试要在页面里点按钮，用这个变量打开 Chrome DevTools 端口。只在隔离实例上认。
if (process.env['FLYINGDRAWS_HOME'] && process.env['FLYINGDRAWS_DEBUG_PORT']) {
  app.commandLine.appendSwitch('remote-debugging-port', String(Number(process.env['FLYINGDRAWS_DEBUG_PORT'])))
}
export const BOARDS_DIR = join(HOME, 'boards')
export const legacyM0Path = join(BOARDS_DIR, 'm0.excalidraw')
export const daemonInfoPath = join(HOME, 'daemon.json')
export const pendingPath = join(HOME, 'pending.json')
export const statePath = join(HOME, 'state.json')
export const libraryPath = join(HOME, 'library.excalidrawlib')
export const libraryStore = new LibraryStore(libraryPath)

export const WAIT_MAX_S = 45
export const WAIT_DEFAULT_S = 40

export const BACKGROUND_ARG = '--background'
export const TEST_INSTANCE = Boolean(process.env['FLYINGDRAWS_HOME'] && process.env['FLYINGDRAWS_DEBUG_PORT'])
export const RENDERER_FILE = join(__dirname, '../renderer/index.html')
