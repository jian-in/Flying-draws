import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

// M0：只有一块固定画板，保存在 ~/.sketchlink/boards/m0.excalidraw
const BOARDS_DIR = join(homedir(), '.sketchlink', 'boards')
const BOARD_ID = 'm0'
const boardPath = join(BOARDS_DIR, `${BOARD_ID}.excalidraw`)

let saveCount = 0

async function loadBoard(): Promise<{ json: string | null; path: string }> {
  try {
    const json = await readFile(boardPath, 'utf8')
    return { json, path: boardPath }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { json: null, path: boardPath }
    throw err
  }
}

async function saveBoard(json: string): Promise<{ path: string; saveCount: number; savedAt: string }> {
  // 先确认是合法 JSON，避免把坏数据写进画板文件
  JSON.parse(json)
  await mkdir(BOARDS_DIR, { recursive: true })
  // 先写临时文件再改名，写到一半崩溃也不会留下半个文件
  const tmp = `${boardPath}.tmp`
  await writeFile(tmp, json, 'utf8')
  await rename(tmp, boardPath)
  saveCount += 1
  return { path: boardPath, saveCount, savedAt: new Date().toISOString() }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Sketchlink (M0)',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  // 画布里的外部链接交给系统浏览器打开，不在应用窗口里跳转
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle('board:load', () => loadBoard())
  ipcMain.handle('board:save', (_event, json: unknown) => {
    if (typeof json !== 'string') throw new Error('board:save expects a JSON string')
    return saveBoard(json)
  })
  ipcMain.handle('board:reveal', () => shell.showItemInFolder(boardPath))

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
