// 只让本应用自己的页面调用主进程：别的来源（导航出去的外部页面、iframe、素材库窗口）一律拒绝。
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { isAppRendererUrl } from './rendererUrl'

export { isAppRendererUrl }

type Event = IpcMainEvent | IpcMainInvokeEvent

export interface IpcGuard {
  trusted(event: Event): boolean
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void
  once(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void
}

export function createIpcGuard(rendererFile: string, devUrl = process.env['ELECTRON_RENDERER_URL']): IpcGuard {
  const trusted = (event: Event): boolean => {
    const frame = event.senderFrame
    // 只认顶层页面；Excalidraw 嵌入的 iframe 不算
    return !!frame && frame.parent === null && isAppRendererUrl(frame.url, rendererFile, devUrl)
  }
  const reject = (channel: string, event: Event): never => {
    throw new Error(`拒绝来自非应用页面的 IPC 调用：${channel} (${event.senderFrame?.url ?? 'unknown'})`)
  }
  return {
    trusted,
    handle(channel, listener) {
      ipcMain.handle(channel, (event, ...args) => (trusted(event) ? listener(event, ...args) : reject(channel, event)))
    },
    on(channel, listener) {
      ipcMain.on(channel, (event, ...args) => {
        if (trusted(event)) listener(event, ...args)
        else console.warn(`[ipc] 忽略来自非应用页面的消息：${channel}`)
      })
    },
    once(channel, listener) {
      const wrapped = (event: IpcMainEvent, ...args: any[]) => {
        if (!trusted(event)) {
          console.warn(`[ipc] 忽略来自非应用页面的消息：${channel}`)
          return
        }
        ipcMain.removeListener(channel, wrapped)
        listener(event, ...args)
      }
      ipcMain.on(channel, wrapped)
    }
  }
}
