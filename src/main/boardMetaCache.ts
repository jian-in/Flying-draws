// 画板列表的元数据缓存。
//
// listBoards() 每次都把每块画板整份读出来 JSON.parse，只为了拿标题、版本和元素数；
// 画板里贴了 agent 的结果图时一份就是几 MB，切画板、改名、MCP canvas_list 都会触发一遍。
// 这里按文件身份（inode + 大小 + mtime）缓存解析结果：画板落盘走原子写（写临时文件再 rename），
// 内容一变 inode 和 mtime 都会变，所以文件没动过就不用再读。
import { readFile, stat } from 'node:fs/promises'
import { parseBoardMeta, type BoardMeta } from './boards.ts'

interface Entry {
  sig: string
  meta: BoardMeta
}

export interface FileSig {
  ino: number | bigint
  size: number
  mtimeMs: number
}

export const sigOf = (st: FileSig): string => `${st.ino}:${st.size}:${st.mtimeMs}`

export class BoardMetaCache {
  private readonly entries = new Map<string, Entry>()
  /** 测试用：实际读文件、解析了几次 */
  parses = 0

  /** 读一块画板的元数据；文件没变就直接用缓存。文件不存在或读不了时抛错，由调用方跳过。 */
  async read(id: string, file: string): Promise<BoardMeta> {
    const st = await stat(file)
    const sig = sigOf(st)
    const hit = this.entries.get(file)
    if (hit && hit.sig === sig) return { ...hit.meta, board: id }
    const json = await readFile(file, 'utf8')
    this.parses += 1
    const meta = parseBoardMeta(id, json, st.mtime.toISOString())
    this.entries.set(file, { sig, meta })
    return meta
  }

  /** 丢掉已经不在列表里的画板，免得删掉的画板一直占着内存 */
  retain(files: Iterable<string>): void {
    const keep = new Set(files)
    for (const key of this.entries.keys()) if (!keep.has(key)) this.entries.delete(key)
  }

  get size(): number {
    return this.entries.size
  }
}
