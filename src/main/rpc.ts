// 主进程向页面发起调用，等页面回复。
import { resolve } from 'node:path'
import { win, ipc, windowReady } from './context'

export let rpcSeq = 0
export const rpcPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

export function rpc<T>(method: string, params: unknown = {}, timeoutMs = 8000): Promise<T> {
  if (!win || win.isDestroyed()) return Promise.reject(new Error('canvas window is not open'))
  const id = ++rpcSeq
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      rpcPending.delete(id)
      reject(new Error(`renderer did not answer ${method} in ${timeoutMs}ms`))
    }, timeoutMs)
    rpcPending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    win!.webContents.send('rpc', { id, method, params })
  })
}

ipc.on('rpc:reply', (_e, msg: { id: number; result?: unknown; error?: string }) => {
  const p = rpcPending.get(msg.id)
  if (!p) return
  clearTimeout(p.timer)
  rpcPending.delete(msg.id)
  if (msg.error) p.reject(new Error(msg.error))
  else p.resolve(msg.result)
})

export function rejectPendingRpcs(reason: string): void {
  const err = new Error(reason)
  for (const [, p] of rpcPending) {
    clearTimeout(p.timer)
    p.reject(err)
  }
  rpcPending.clear()
}

export interface Snapshot {
  board?: string
  sceneJson: string
  pngBase64: string | null
  view?: { x: number; y: number; w: number; h: number } | null // 用户当前看得见的那块画布
}

export async function takeSnapshot(withImage: boolean): Promise<Snapshot> {
  await windowReady
  return rpc<Snapshot>('snapshot', { image: withImage })
}
