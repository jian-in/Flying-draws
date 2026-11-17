// 原子写 JSON 文件：先写临时文件再改名，读的人永远看不到半截内容。
// 同一个文件的多次写入排成一队按调用顺序落盘——页面的自动保存和 agent 的读取可能同时触发写盘，
// 不排队的话两次写入会抢同一个临时文件（后改名的那次报 ENOENT），或者旧内容后落盘盖掉新内容。
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const chains = new Map<string, Promise<void>>()
let seq = 0

export function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  // 调用时就序列化：排队期间调用方再改这个对象也不影响这次要写的内容
  const text = JSON.stringify(data)
  return atomicWrite(filePath, text)
}

export function atomicWriteBytes(filePath: string, bytes: Uint8Array): Promise<void> {
  return atomicWrite(filePath, Buffer.from(bytes))
}

function atomicWrite(filePath: string, text: string | Buffer): Promise<void> {
  const prev = chains.get(filePath) ?? Promise.resolve()
  const run = prev.then(async () => {
    await mkdir(dirname(filePath), { recursive: true })
    seq += 1
    const tmp = `${filePath}.${process.pid}.${seq}.tmp`
    try {
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, filePath)
    } catch (err) {
      await unlink(tmp).catch(() => undefined)
      throw err
    }
  })
  const tail = run.catch(() => undefined)
  chains.set(filePath, tail)
  void tail.then(() => {
    if (chains.get(filePath) === tail) chains.delete(filePath)
  })
  return run
}
