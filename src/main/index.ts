import { app, BrowserWindow } from 'electron'
import { createDaemonLifecycle, startDaemon } from './daemon'
import { daemonInfoPath } from './paths'
import { agent, quitting, setQuitting } from './context'
import { restorePending } from './boardState'
import { tray, createTray, bringToFront, createWindow, closeLibraryWindow } from './window'
import { routes } from './routes'
import './ipcHandlers'

// ---------- 启动 ----------

// 同一时间只允许一个实例，第二次启动时把已有窗口带到前面
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => bringToFront())

  const daemon = createDaemonLifecycle()

  app.whenReady().then(async () => {
    if (daemon.isQuitting()) return
    restorePending()
    createWindow()
    createTray()
    await daemon.start(() => startDaemon(daemonInfoPath, routes))
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    // 常驻时窗口只是藏起来；万一页面进程崩了窗口没了，托盘还在，点它会重新打开
    if (process.platform !== 'darwin' && (quitting || !tray)) app.quit()
  })

  app.on('before-quit', () => {
    setQuitting(true)
    daemon.markQuitting()
    closeLibraryWindow()
  })

  let engineClosing = false
  let engineClosed = false
  app.on('before-quit', (event) => {
    if (engineClosed) return
    event.preventDefault()
    if (engineClosing) return
    engineClosing = true
    void agent.close().catch(error => console.error('[flyingdraws] agent shutdown failed:', error)).finally(() => {
      engineClosed = true
      app.quit()
    })
  })

  app.on('will-quit', (event) => {
    const closing = daemon.closeOnQuit()
    if (!closing) return
    event.preventDefault()
    void closing.finally(() => app.quit())
  })
}
