// 在线 agent 席位登记表：跟踪当前连着画布的 MCP 桥接进程或直接调用方，
// 让还没落笔的席位也能实时出现在界面状态栏里。不依赖 Electron，可单独单测。

export const SEAT_COLORS = ['#1971c2', '#7048e8', '#0c8599', '#d9480f', '#2f9e44', '#c2255c'] as const

export const SEAT_TTL_MS = 90_000

// 给新席位挑颜色：优先用色板里还没人用的；六种都用过了再按席位个数循环。
// 不能直接按「已有席位数」取下标：画板上留下来的席位不一定占着色板的前几种颜色
// （比如第一个席位画的东西被删光了），那样新席位会和还在的席位撞色。
export function nextSeatColor(used: Iterable<string>, count: number): string {
  const taken = new Set(used)
  for (const c of SEAT_COLORS) if (!taken.has(c)) return c
  return SEAT_COLORS[count % SEAT_COLORS.length]
}

export interface OnlineSeat {
  name: string
  color: string
  explicit: boolean
  waiting: boolean
  drawn: boolean
}

interface SeatEntry {
  key: string
  name: string
  clientName: string | null
  explicit: boolean
  lastSeen: number
}

export interface TouchSeatInput {
  bridgeId?: string | null
  agent?: string | null
  as?: string | null
  now?: number
}

export interface ListSeatsContext {
  boardSeats: ReadonlyMap<string, string>
  drawnNames?: ReadonlySet<string>
  waitingAgents?: readonly string[]
  now?: number
}

const cleanName = (v: string | null | undefined): string | null => {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed || null
}

/** 维护当前在线的 agent 席位及离线清理 */
export class SeatRegistry {
  private entries = new Map<string, SeatEntry>()
  private onChangeFn: (() => void) | null = null

  onChange(fn: () => void): void {
    this.onChangeFn = fn
  }

  touch(input: TouchSeatInput): boolean {
    const now = input.now ?? Date.now()
    const asName = cleanName(input.as)
    const clientName = cleanName(input.agent)
    const bridgeId = cleanName(input.bridgeId)
    const candidateName = asName ?? clientName
    if (!candidateName && !bridgeId) return false

    const key = bridgeId ?? `direct:${candidateName}`
    const prev = this.entries.get(key)
    if (!candidateName) {
      if (!prev) return false
      prev.lastSeen = now
      return false
    }

    // 同一条桥接已经声明过具名席位（如 as: "architect"）时，后续没带 as 的调用不能把名字退回客户端名
    const keepExplicit = Boolean(prev?.explicit && !asName && (!clientName || clientName === prev.clientName))
    const nextName = keepExplicit ? prev!.name : candidateName
    const nextExplicit = keepExplicit ? true : Boolean(asName)
    const nextClient = clientName ?? prev?.clientName ?? null

    const changed = !prev || prev.name !== nextName || prev.explicit !== nextExplicit
    this.entries.set(key, {
      key,
      name: nextName,
      clientName: nextClient,
      explicit: nextExplicit,
      lastSeen: now
    })
    if (changed) this.onChangeFn?.()
    return changed
  }

  leave(bridgeIdRaw: string): boolean {
    const bridgeId = cleanName(bridgeIdRaw)
    if (!bridgeId) return false
    const deleted = this.entries.delete(bridgeId)
    if (deleted) this.onChangeFn?.()
    return deleted
  }

  prune(waitingAgents: readonly string[] = [], now = Date.now()): boolean {
    const waiting = new Set(waitingAgents)
    let changed = false
    for (const [key, entry] of this.entries) {
      if (waiting.has(entry.name)) {
        entry.lastSeen = now
        continue
      }
      if (now - entry.lastSeen > SEAT_TTL_MS) {
        this.entries.delete(key)
        changed = true
      }
    }
    if (changed) this.onChangeFn?.()
    return changed
  }

  hasEntries(): boolean {
    return this.entries.size > 0
  }

  list(ctx: ListSeatsContext): OnlineSeat[] {
    const now = ctx.now ?? Date.now()
    const waitingList = ctx.waitingAgents ?? []
    const waiting = new Set(waitingList)
    for (const [key, entry] of this.entries) {
      if (waiting.has(entry.name)) entry.lastSeen = now
      else if (now - entry.lastSeen > SEAT_TTL_MS) this.entries.delete(key)
    }

    const merged = new Map<string, { name: string; explicit: boolean }>()
    for (const entry of this.entries.values()) {
      const prev = merged.get(entry.name)
      if (!prev) merged.set(entry.name, { name: entry.name, explicit: entry.explicit })
      else if (entry.explicit && !prev.explicit) prev.explicit = true
    }
    for (const name of waitingList) {
      if (name && !merged.has(name)) merged.set(name, { name, explicit: true })
    }

    // 预览色优先复用当前画板上已分配的颜色；还没落笔的席位按空闲色板顺延，不提前占用 boardSeats
    const usedColors = new Set(ctx.boardSeats.values())
    let fallbackIdx = ctx.boardSeats.size
    const pickPreviewColor = (): string => {
      const c = nextSeatColor(usedColors, fallbackIdx)
      if (usedColors.has(c)) fallbackIdx += 1
      else usedColors.add(c)
      return c
    }

    const drawnNames = ctx.drawnNames ?? new Set<string>()
    return [...merged.values()].map((item) => ({
      name: item.name,
      color: ctx.boardSeats.get(item.name) ?? pickPreviewColor(),
      explicit: item.explicit,
      waiting: waiting.has(item.name),
      drawn: drawnNames.has(item.name)
    }))
  }
}
