import { contextBridge, ipcRenderer } from 'electron'

// 渲染进程只能通过这几个函数和主进程打交道，拿不到完整的 Node 能力
contextBridge.exposeInMainWorld('flyingdraws', {
  agent: {
    state: () => ipcRenderer.invoke('agent:state'),
    connect: (board: string) => ipcRenderer.invoke('agent:connect', board),
    configure: (draft: unknown) => ipcRenderer.invoke('agent:configure', draft),
    models: (query: unknown) => ipcRenderer.invoke('agent:models', query),
    selectModel: (provider: string, model: string) => ipcRenderer.invoke('agent:model', provider, model),
    setApprovalMode: (mode: 'auto-safe' | 'full-access') => ipcRenderer.invoke('agent:approval-mode', mode),
    chooseWorkspace: (board: string) => ipcRenderer.invoke('agent:workspace', board),
    newTask: (board: string) => ipcRenderer.invoke('agent:new', board),
    openTask: (id: string) => ipcRenderer.invoke('agent:open', id),
    submit: (input: unknown) => ipcRenderer.invoke('agent:submit', input),
    execute: (text: string) => ipcRenderer.invoke('agent:execute', text),
    cancel: () => ipcRenderer.invoke('agent:cancel'),
    approve: (requestId: string, approved: boolean, remember?: boolean) => ipcRenderer.invoke('agent:approve', requestId, approved, remember),
    clearAllowedCommands: () => ipcRenderer.invoke('agent:clear-allowed'),
    review: (runId: string, verdict: 'approved' | 'rejected', note?: string) => ipcRenderer.invoke('agent:review', runId, verdict, note),
    image: (id: string) => ipcRenderer.invoke('agent:image', id),
    roundDiff: (runId: string, path?: string) => ipcRenderer.invoke('agent:round-diff', runId, path),
    onState: (fn: (state: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: unknown) => fn(state)
      ipcRenderer.on('agent:state', listener)
      return () => ipcRenderer.removeListener('agent:state', listener)
    }
  },
  captureWindow: process.env['FLYINGDRAWS_HOME'] && process.env['FLYINGDRAWS_DEBUG_PORT']
    ? () => ipcRenderer.invoke('test:capture-window') : undefined,
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
  loadLibrary: () => ipcRenderer.invoke('library:load'),
  saveLibrary: (data: { libraryItems: readonly unknown[] }) => ipcRenderer.invoke('library:save', data),
  onLibraryInstall: (fn: (payload: { json?: string; itemCount?: number; error?: string }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { json?: string; itemCount?: number; error?: string }) =>
      fn(payload)
    ipcRenderer.on('library:install', listener)
    return () => ipcRenderer.removeListener('library:install', listener)
  },
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
    board?: string
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
