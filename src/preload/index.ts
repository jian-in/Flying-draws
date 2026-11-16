import { contextBridge, ipcRenderer } from 'electron'

// 渲染进程只能通过这几个函数和主进程打交道，拿不到完整的 Node 能力
contextBridge.exposeInMainWorld('sketchlink', {
  loadBoard: () => ipcRenderer.invoke('board:load'),
  listBoards: () => ipcRenderer.invoke('board:list'),
  saveBoard: (json: string) => ipcRenderer.invoke('board:save', json),
  createBoard: (payload: { name: string; title?: string; currentSceneJson?: string }) =>
    ipcRenderer.invoke('board:create', payload),
  switchBoard: (payload: { board: string; currentSceneJson?: string }) => ipcRenderer.invoke('board:switch', payload),
  renameBoard: (payload: { board?: string; name: string; title?: string | null; currentSceneJson?: string }) =>
    ipcRenderer.invoke('board:rename', payload),
  deleteBoard: (payload: { board: string; currentSceneJson?: string }) => ipcRenderer.invoke('board:delete', payload),
  revealBoard: () => ipcRenderer.invoke('board:reveal'),

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
  }) => ipcRenderer.invoke('hub:submit', payload),
  cancel: (requestId: string) => ipcRenderer.invoke('hub:cancel', requestId),

  // 主进程发起的调用：页面处理完用 rpcReply 回复
  onRpc: (fn: (msg: { id: number; method: string; params: unknown }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, msg: { id: number; method: string; params: unknown }) => fn(msg)
    ipcRenderer.on('rpc', listener)
    return () => ipcRenderer.removeListener('rpc', listener)
  },
  rpcReply: (id: number, result: unknown, error?: string) => ipcRenderer.send('rpc:reply', { id, result, error }),
  ready: () => ipcRenderer.send('renderer:ready'),

  // 隔离的测试实例上为 true，页面据此把画布接口挂到 window 上供端到端测试用
  testMode: Boolean(process.env['SKETCHLINK_HOME'] && process.env['SKETCHLINK_DEBUG_PORT'])
})
