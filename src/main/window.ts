// 主窗口、托盘与后台常驻、素材库浏览窗口。
// 关窗口只是把窗口藏起来：页面还活着，画布读写、内置 Agent 和外部 agent 的连接都照常工作。
// 真正退出走托盘菜单的「退出」（或系统注销/关机）。隔离的测试实例不常驻，关窗口照旧退出。
import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, shell, Tray } from 'electron'
import { join, resolve } from 'node:path'
import { WindowDock } from './dock'
import { isAppRendererUrl } from './ipcGuard'
import { trayRepresentations } from './trayIcon'
import { freshApprovals, hasPendingApprovals, trayTooltip } from './agentNotice'
import { AGENT_SEAT, type AgentState } from '../shared/agent'
import { isExcalidrawLibraryBrowseUrl, MAX_LIBRARY_BYTES, parseLibraryInstallNavigation } from '../shared/library'
import { parseAndValidateLibraryJson } from './library'
import { BACKGROUND_ARG, TEST_INSTANCE, RENDERER_FILE, statePath } from './paths'
import { win, setWin, ipc, agent, quitting, setQuitting, setWindowReady, savedTheme, setSavedTheme } from './context'
import { patchAppStateFile } from './appStateFile'
import { rejectPendingRpcs } from './rpc'
import { updateWindowTitle } from './boardState'

export let tray: Tray | null = null
let libraryWin: BrowserWindow | null = null
export let backgroundHintShown = false
// 开机自启时带着 --background，第一次只建窗口不显示
export let launchHidden = process.argv.includes(BACKGROUND_ARG)

export function trayImage(alert = false): Electron.NativeImage {
  const image = nativeImage.createEmpty()
  for (const rep of trayRepresentations(app.getAppPath(), alert)) image.addRepresentation(rep)
  return image
}

// 开机自启只在打包后的应用里提供：开发时注册的会是 electron.exe；自定义数据目录的实例开机时也带不上那个目录
export const loginItemSupported = (): boolean => app.isPackaged && !process.env['FLYINGDRAWS_HOME']
export const openAtLogin = (): boolean =>
  loginItemSupported() && app.getLoginItemSettings({ args: [BACKGROUND_ARG] }).openAtLogin

export function refreshTrayMenu(): void {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Flying draws', click: () => bringToFront() },
    { type: 'separator' },
    {
      label: '开机时在后台启动',
      type: 'checkbox',
      checked: openAtLogin(),
      enabled: loginItemSupported(),
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: [BACKGROUND_ARG] })
        refreshTrayMenu()
      }
    },
    { type: 'separator' },
    { label: '退出 Flying draws', click: () => { setQuitting(true); app.quit() } }
  ]))
}

export function createTray(): void {
  if (tray || TEST_INSTANCE) return
  tray = new Tray(trayImage())
  tray.setToolTip('Flying draws')
  tray.on('click', () => bringToFront())
  tray.on('balloon-click', () => bringToFront())
  refreshTrayMenu()
  // 托盘提示跟着内置 Agent 的状态走：藏在后台时也看得出它是在干活还是在等你确认。
  // 等审批时窗口不在眼前（藏着、最小化或在别的窗口后面），弹一条提醒，免得任务无声地挂着。
  const notified = new Set<string>()
  let alerting = false
  agent.on('state', (state: AgentState) => {
    tray?.setToolTip(trayTooltip(state))
    // 托盘图标的红点不依赖系统通知：通知被关掉时也看得见
    const alert = hasPendingApprovals(state)
    if (tray && alert !== alerting) {
      alerting = alert
      tray.setImage(trayImage(alert))
    }
    const fresh = freshApprovals(state, notified)
    const away = !win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || !win.isFocused()
    if (!fresh.length || !away || !tray || process.platform !== 'win32') return
    tray.displayBalloon({
      iconType: 'info',
      title: `${AGENT_SEAT} 等你确认`,
      content: `${fresh.join('、')}：点这里打开 Flying draws 处理。确认前任务会一直等着。`
    })
  })
}

/** 隐藏到后台；页面不降频，画布读写和 Agent 回填照常及时。 */
export function hideToBackground(target: BrowserWindow): void {
  target.webContents.setBackgroundThrottling(false)
  target.hide()
  if (backgroundHintShown || !tray) return
  backgroundHintShown = true
  if (process.platform === 'win32') {
    tray.displayBalloon({
      iconType: 'info',
      title: 'Flying draws 还在后台运行',
      content: '内置 Agent 和画布连接都保持可用。点托盘图标打开，右键菜单里可以退出。'
    })
  }
}
if (process.env['FLYINGDRAWS_HOME'] && process.env['FLYINGDRAWS_DEBUG_PORT']) {
  ipc.handle('test:capture-window', async () => {
    if (!win || win.isDestroyed()) throw new Error('测试窗口未就绪')
    return (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')
  })
}

// 顶上那一条的高度和颜色，要和 styles.css 里的 --fd-titlebar-h、--fd-paper 保持一致
export const TITLEBAR_HEIGHT = 36
export const TITLEBAR_COLORS = {
  light: { color: '#fffbe6', symbolColor: '#2b2a26' },
  dark: { color: '#181508', symbolColor: '#e9e2c8' }
}

export function bringToFront(): void {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  // Windows 会拦截后台程序抢焦点，短暂置顶再取消，保证窗口能跳到前面
  win.setAlwaysOnTop(true)
  win.focus()
  setTimeout(() => {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(false)
  }, 300)
}

export let dock: WindowDock | null = null

export function createWindow(): void {
  const win = new BrowserWindow({
    icon: join(app.getAppPath(), 'resources', 'icon', 'icon-256.png'),
    show: !launchHidden && !(process.env['FLYINGDRAWS_HOME'] && process.env['FLYINGDRAWS_DEBUG_PORT'] && process.env['FLYINGDRAWS_TEST_HIDDEN'] === '1'),
    width: 1280,
    height: 820,
    title: 'Flying draws',
    // 不用系统自带的标题栏和菜单栏：顶上那一条由页面自己画成纸色，只留系统的最小化/最大化/关闭按钮
    titleBarStyle: 'hidden',
    // 按上次的深浅色起窗口，深色用户启动时不会先闪一下浅色
    titleBarOverlay: { ...TITLEBAR_COLORS[savedTheme], height: TITLEBAR_HEIGHT },
    backgroundColor: TITLEBAR_COLORS[savedTheme].color,
    autoHideMenuBar: true,
    webPreferences: {
      backgroundThrottling: !(process.env['FLYINGDRAWS_HOME'] && process.env['FLYINGDRAWS_DEBUG_PORT']),
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })
  setWin(win)
  const overlayTarget = win
  // 窗口吸附：拖到别的窗口旁边松手就贴上去，状态变了告诉页面（隔离测试实例不启用系统级吸附）
  dock = TEST_INSTANCE
    ? null
    : new WindowDock(win, (state) => {
        if (!overlayTarget.isDestroyed()) overlayTarget.webContents.send('dock:state', state)
      })
  ipcMain.removeAllListeners('window:theme')
  ipc.on('window:theme', (_e, theme: unknown) => {
    if (overlayTarget.isDestroyed()) return
    const next = theme === 'dark' ? 'dark' : 'light'
    setSavedTheme(next)
    // 去重交给 patchAppStateFile 按文件内容判断：上次写失败的话，同样的值这次还会再写
    try {
      patchAppStateFile(statePath, { theme: next })
    } catch (err) {
      console.error('[flyingdraws] could not save theme:', err)
    }
    const colors = TITLEBAR_COLORS[next]
    // 只有 Windows 和 Linux 上能改这几个按钮的颜色
    if (process.platform !== 'darwin') overlayTarget.setTitleBarOverlay({ ...colors, height: TITLEBAR_HEIGHT })
    overlayTarget.setBackgroundColor(colors.color)
  })
  const armWindowReady = () => {
    ipcMain.removeAllListeners('renderer:ready')
    setWindowReady(new Promise<void>((resolve) => ipc.once('renderer:ready', () => resolve())))
  }
  armWindowReady()
  ipcMain.removeAllListeners('window:reload')
  ipc.on('window:reload', () => {
    if (!overlayTarget.isDestroyed()) {
      rejectPendingRpcs('canvas window reloaded')
      armWindowReady()
      // 不用 webContents.reload()：地址上的深浅色可能是启动时的旧值，按现在的重新载入
      loadRenderer(overlayTarget)
    }
  })
  ipcMain.removeAllListeners('window:devtools')
  ipc.on('window:devtools', () => {
    if (!overlayTarget.isDestroyed()) overlayTarget.webContents.toggleDevTools()
  })
  updateWindowTitle()

  // 主窗口只显示本应用页面：拖进来的链接/文件、页面里的跳转都不能把它带到外部地址（preload 的 API 只给自己人）
  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (isAppRendererUrl(targetUrl, RENDERER_FILE, process.env['ELECTRON_RENDERER_URL'])) return
    event.preventDefault()
    if (targetUrl.startsWith('https://') || targetUrl.startsWith('http://')) void shell.openExternal(targetUrl)
  })
  win.webContents.on('will-redirect', (event, targetUrl) => {
    if (!isAppRendererUrl(targetUrl, RENDERER_FILE, process.env['ELECTRON_RENDERER_URL'])) event.preventDefault()
  })
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExcalidrawLibraryBrowseUrl(url)) {
      openLibraryBrowserWindow(url)
      return { action: 'deny' }
    }
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('closed', () => {
    rejectPendingRpcs('canvas window closed')
    setWin(null)
  })
  if (launchHidden) {
    launchHidden = false
    win.webContents.setBackgroundThrottling(false)
  }
  win.on('close', (event) => {
    if (quitting || !tray) return
    event.preventDefault()
    hideToBackground(overlayTarget)
  })
  win.on('show', () => {
    // 回到前台后恢复默认的后台降频设置（测试实例本来就关着降频）
    overlayTarget.webContents.setBackgroundThrottling(!(process.env['FLYINGDRAWS_HOME'] && process.env['FLYINGDRAWS_DEBUG_PORT']))
  })
  // Windows 注销、关机时没有 before-quit，这里放行关窗口，别挡住系统
  win.on('session-end', () => {
    setQuitting(true)
  })

  loadRenderer(win)
}

// 地址上带着上次的深浅色，index.html 在样式生效前就用它设好 data-fd-theme
function loadRenderer(target: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!devUrl) {
    void target.loadFile(RENDERER_FILE, { query: { theme: savedTheme } })
    return
  }
  let url = devUrl
  try {
    const parsed = new URL(devUrl)
    parsed.searchParams.set('theme', savedTheme)
    url = parsed.href
  } catch {
    // dev 地址写坏了就原样加载
  }
  void target.loadURL(url)
}

export async function fetchAndInstallRemoteLibrary(libraryUrl: string): Promise<void> {
  bringToFront()
  try {
    const res = await net.fetch(libraryUrl, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const reader = res.body?.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          total += value.byteLength
          if (total > MAX_LIBRARY_BYTES) {
            await reader.cancel().catch(() => undefined)
            throw new Error(`素材库文件体积超出上限（>${Math.round(MAX_LIBRARY_BYTES / (1024 * 1024))} MiB）`)
          }
          chunks.push(value)
        }
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer())
      if (buf.byteLength > MAX_LIBRARY_BYTES) {
        throw new Error(`素材库文件体积超出上限（>${Math.round(MAX_LIBRARY_BYTES / (1024 * 1024))} MiB）`)
      }
      chunks.push(buf)
    }
    const rawText = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
    const { json, itemCount } = parseAndValidateLibraryJson(rawText)
    if (win && !win.isDestroyed()) {
      win.webContents.send('library:install', { json, itemCount })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (win && !win.isDestroyed()) {
      win.webContents.send('library:install', { error: message })
    }
  }
}

export function openLibraryBrowserWindow(browseUrl: string): void {
  if (libraryWin && !libraryWin.isDestroyed()) {
    void libraryWin.loadURL(browseUrl)
    libraryWin.focus()
    return
  }
  const child = new BrowserWindow({
    icon: join(app.getAppPath(), 'resources', 'icon', 'icon-256.png'),
    parent: win && !win.isDestroyed() ? win : undefined,
    width: 1080,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    autoHideMenuBar: true,
    title: '浏览社区素材库 — 点击「Add to Excalidraw」即刻装入画布',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:excalidraw-libraries'
    }
  })
  libraryWin = child

  const interceptInstallUrl = (targetUrl: string): boolean => {
    try {
      const match = parseLibraryInstallNavigation(targetUrl)
      if (!match) return false
      if (!child.isDestroyed()) child.close()
      void fetchAndInstallRemoteLibrary(match.libraryUrl)
      return true
    } catch (err) {
      if (!child.isDestroyed()) child.close()
      bringToFront()
      if (win && !win.isDestroyed()) {
        win.webContents.send('library:install', {
          error: err instanceof Error ? err.message : String(err)
        })
      }
      return true
    }
  }

  child.webContents.on('will-navigate', (event, targetUrl) => {
    if (interceptInstallUrl(targetUrl)) {
      event.preventDefault()
      return
    }
    if (!isExcalidrawLibraryBrowseUrl(targetUrl)) {
      event.preventDefault()
      if (targetUrl.startsWith('https://') || targetUrl.startsWith('http://')) {
        void shell.openExternal(targetUrl)
      }
    }
  })

  child.webContents.on('will-redirect', (event, targetUrl) => {
    if (interceptInstallUrl(targetUrl)) {
      event.preventDefault()
    }
  })

  child.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (interceptInstallUrl(targetUrl)) return { action: 'deny' }
    if (isExcalidrawLibraryBrowseUrl(targetUrl)) {
      void child.loadURL(targetUrl)
      return { action: 'deny' }
    }
    if (targetUrl.startsWith('https://') || targetUrl.startsWith('http://')) {
      void shell.openExternal(targetUrl)
    }
    return { action: 'deny' }
  })

  child.on('closed', () => {
    if (libraryWin === child) libraryWin = null
  })

  void child.loadURL(browseUrl)
}

/** 退出时关掉素材库窗口 */
export function closeLibraryWindow(): void {
  if (libraryWin && !libraryWin.isDestroyed()) {
    libraryWin.destroy()
    libraryWin = null
  }
}
