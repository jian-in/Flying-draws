import { contextBridge, ipcRenderer } from 'electron'

// 渲染进程只能通过这几个函数和主进程打交道，拿不到完整的 Node 能力
contextBridge.exposeInMainWorld('sketchlink', {
  loadBoard: () => ipcRenderer.invoke('board:load'),
  saveBoard: (json: string) => ipcRenderer.invoke('board:save', json),
  revealBoard: () => ipcRenderer.invoke('board:reveal'),

  getHubState: () => ipcRenderer.invoke('hub:state'),
  onHubState: (fn: (state: unknown) => void) => {
    ipcRenderer.on('hub:state', (_e, state) => fn(state))
  },
  submit: (payload: {
    requestId: string | null
    note: string
    sceneJson: string
    pngBase64: string | null
    decision?: 'accepted' | 'rejected' | null
  }) =>
    ipcRenderer.invoke('hub:submit', payload),
  cancel: (requestId: string) => ipcRenderer.invoke('hub:cancel', requestId),

  // 主进程发起的调用：页面处理完用 rpcReply 回复
  onRpc: (fn: (msg: { id: number; method: string; params: unknown }) => void) => {
    ipcRenderer.on('rpc', (_e, msg) => fn(msg))
  },
  rpcReply: (id: number, result: unknown, error?: string) => ipcRenderer.send('rpc:reply', { id, result, error }),
  ready: () => ipcRenderer.send('renderer:ready')
})
