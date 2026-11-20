// 画板列表的元数据缓存。
//
// listBoards() 每次都把每块画板整份读出来 JSON.parse，只为了拿标题、版本和元素数；
// 画板里贴了 agent 的结果图时一份就是几 MB，切画板、改名、MCP canvas_list 都会触发一遍。
// 这里按文件身份（inode + 大小 + mtime + ctime）缓存解析结果：画板落盘走原子写（写临时文件再 rename），
// 内容一变 inode 和时间都会变，所以文件没动过就不用再读。
// 用 bigint 取 stat：Windows 的文件 ID 是 64 位，转成 number 会丢精度；时间也按纳秒比，不受毫秒舍入影响。
import { readFile, stat } from 'node:fs/promises'
import { parseBoardMeta, type BoardMeta } from './boards.ts'

interface Entry {
  sig: string
  meta: BoardMeta
}

export interface FileSig {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

export const sigOf = (st: FileSig): string => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`

/** 同时最多整份读几块画板：冷启动时几十块带图的大画板一起读，会同时占着内存 */
export const READ_CONCURRENCY = 4

export class BoardMetaCache {
  private readonly entries = new Map<string, Entry>()
  private readonly limit: number
  private reading = 0
  private readonly waiting: (() => void)[] = []
  /** 测试用：实际读文件、解析了几次 */
  parses = 0
  /** 测试用：同时整份读文件最多的时候有几块 */
  peakReading = 0

  constructor(limit = READ_CONCURRENCY) {
    this.limit = Math.max(1, limit)
  }

  /**
   * 读一块画板的元数据；文件没变就直接用缓存。文件不存在或读不了时抛错，由调用方跳过。
   * 整份读文件的并发上限挂在这个实例上，IPC 和 MCP 同时来列表也共用一个上限；stat 和命中缓存不排队。
   */
  async read(id: string, file: string): Promise<BoardMeta> {
    const st = await stat(file, { bigint: true })
    const sig = sigOf(st)
    const hit = this.entries.get(file)
    if (hit && hit.sig === sig) return { ...hit.meta, board: id }
    await this.acquire()
    try {
      const json = await readFile(file, 'utf8')
      this.parses += 1
      const meta = parseBoardMeta(id, json, st.mtime.toISOString())
      this.entries.set(file, { sig, meta })
      return meta
    } finally {
      this.release()
    }
  }

  /** 按顺序读一批画板，读不了的位置是 null；读完顺手清掉不在这批里的条目。 */
  async readAll(boards: ReadonlyArray<{ id: string; file: string }>): Promise<(BoardMeta | null)[]> {
    const metas = await Promise.all(boards.map((b) => this.read(b.id, b.file).catch(() => null)))
    this.retain(boards.map((b) => b.file))
    return metas
  }

  /** 丢掉已经不在列表里的画板，免得删掉的画板一直占着内存 */
  retain(files: Iterable<string>): void {
    const keep = new Set(files)
    for (const key of this.entries.keys()) if (!keep.has(key)) this.entries.delete(key)
  }

  get size(): number {
    return this.entries.size
  }

  private acquire(): Promise<void> {
    if (this.reading < this.limit) {
      this.reading += 1
      this.peakReading = Math.max(this.peakReading, this.reading)
      return Promise.resolve()
    }
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  private release(): void {
    const next = this.waiting.shift()
    // 有人在等就把名额直接交给它，reading 不变
    if (next) next()
    else this.reading -= 1
  }
}
