import { contextBridge, ipcRenderer } from 'electron'

// 渲染进程只能通过这几个函数碰到磁盘，拿不到完整的 Node 能力
contextBridge.exposeInMainWorld('sketchlink', {
  loadBoard: () => ipcRenderer.invoke('board:load'),
  saveBoard: (json: string) => ipcRenderer.invoke('board:save', json),
  revealBoard: () => ipcRenderer.invoke('board:reveal')
})
