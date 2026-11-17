import { contextBridge, ipcRenderer } from 'electron'

// 渲染进程只能通过这几个函数和主进程打交道，拿不到完整的 Node 能力
contextBridge.exposeInMainWorld('flyingdraws', {
  loadBoard: () => ipcRenderer.invoke('board:load'),
  listBoards: () => ipcRenderer.invoke('board:list'),
  saveBoard: (json: string, board?: string) => ipcRenderer.invoke('board:save', json, board),
  createBoard: (payload: { name: string; title?: string; currentSceneJson?: string }) =>
    ipcRenderer.invoke('board:create', payload),
  switchBoard: (payload: { board: string; currentSceneJson?: string }) => ipcRenderer.invoke('board:switch', payload),
  renameBoard: (payload: { board?: string; name: string; title?: string | null; currentSceneJson?: string }) =>
    ipcRenderer.invoke('board:rename', payload),
  deleteBoard: (payload: { board: string; currentSceneJson?: string }) => ipcRenderer.invoke('board:delete', payload),
  revealBoard: () => ipcRenderer.invoke('board:reveal'),
  // 页面的深浅色变了：让窗口右上角的最小化/关闭按钮跟着换颜色
  setTheme: (theme: 'light' | 'dark') => ipcRenderer.send('window:theme', theme),
  // 系统菜单栏去掉以后，这两项挪到了页面的「⋯」菜单里
  reloadWindow: () => ipcRenderer.send('window:reload'),
  toggleDevTools: () => ipcRenderer.send('window:devtools'),

  getHubState: () => ipcRenderer.invoke('hub:state'),
  onHubState: (fn: (state: unknown) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: unknown) => fn(state)
    ipcRenderer.on('hub:state', listener)
    return () => ipcRenderer.removeListener('hub:state', listener)
  },
  submit: (payload: {
    requestId: string | null
    note: string
    sceneJson: string
    pngBase64: string | null
    decision?: 'accepted' | 'rejected' | null
    skipped?: string[]
    to?: string | null
  }) => ipcRenderer.invoke('hub:submit', payload),
  cancel: (requestId: string) => ipcRenderer.invoke('hub:cancel', requestId),

  // 窗口吸附：画布贴在哪个窗口旁边
  getDockState: () => ipcRenderer.invoke('dock:state'),
  onDockState: (fn: (state: unknown) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: unknown) => fn(state)
    ipcRenderer.on('dock:state', listener)
    return () => ipcRenderer.removeListener('dock:state', listener)
  },
  releaseDock: () => ipcRenderer.send('dock:release'),
  copyHint: () => ipcRenderer.invoke('hub:hint'),

  // 主进程发起的调用：页面处理完用 rpcReply 回复
  onRpc: (fn: (msg: { id: number; method: string; params: unknown }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, msg: { id: number; method: string; params: unknown }) => fn(msg)
    ipcRenderer.on('rpc', listener)
    return () => ipcRenderer.removeListener('rpc', listener)
  },
  rpcReply: (id: number, result: unknown, error?: string) => ipcRenderer.send('rpc:reply', { id, result, error }),
  ready: () => ipcRenderer.send('renderer:ready'),

  // 隔离的测试实例上为 true，页面据此把画布接口挂到 window 上供端到端测试用
  testMode: Boolean(process.env['FLYINGDRAWS_HOME'] && process.env['FLYINGDRAWS_DEBUG_PORT'])
})
