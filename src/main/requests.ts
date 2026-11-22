// agent 的绘图请求和用户的"发送"，以及 agent 端的长轮询等待。
// 不依赖 Electron，可以单独测试。
import type { OnlineSeat } from './seats.ts'

export interface Submission {
  requestId: string | null // null 表示用户主动发送，不是回应某个请求
  note: string
  sceneJson: string
  pngBase64: string | null
  version: number
  at: string
  decision?: 'accepted' | 'rejected' | null // 只有回应提议时才有
  changes?: string[] | null // 回应提议时：用户在提议上改了什么（中文句子）
  to?: string | null // 用户主动发送时点选的目标席位；没选就是发给任意 agent
}

export interface Handoff {
  from: string
  to: string | null // null 表示递给任意其他 agent
  note: string
  sceneJson: string
  pngBase64: string | null
  version: number
  at: string
}

// agent 没在等时，放进剪贴板让用户粘贴到聊天里的一句话：说清是哪块画板、哪个版本、发给谁、怎么取
export function pickupHint(p: { board: string; title?: string | null; version: number; to?: string | null }): string {
  const name = p.title ? `「${p.title}」（${p.board}）` : `「${p.board}」`
  const args = [`board: "${p.board}"`, ...(p.to ? [`as: "${p.to}"`] : [])].join('，')
  return `我在 Flying draws 画板${name}上画好了（v${p.version}）${p.to ? `，发给席位「${p.to}」` : ''}。请调用 canvas_read（${args}）来取。`
}

export type RequestKind ='draw' | 'proposal' // draw：请用户画；proposal：agent 画了提议，请用户确认

export interface DrawRequest {
  id: string
  kind: RequestKind
  proposalId: string | null // 提议层元素上打的标记，页面靠它找到这批元素
  baseline: unknown // 提议画上去时的底稿，用户表态时拿来比出改了什么；这里不关心它的结构
  pending?: unknown // 提议里包含的修改/删除，用户点接受时才执行
  prompt: string
  createdAt: string
  status: 'waiting' | 'submitted' | 'cancelled'
  submission: Submission | null
}

export type WaitResult =
  | { status: 'submitted'; submission: Submission }
  | { status: 'handoff'; handoff: Handoff }
  | { status: 'cancelled'; requestId: string }
  | { status: 'waiting'; waitingFor: 'user' }
  | { status: 'unknown_request'; requestId: string }

export type WaitTarget = { requestId: string } | { inbox: true; agent?: string | null }

interface Waiter {
  target: WaitTarget
  resolve: (r: WaitResult) => void
  timer: ReturnType<typeof setTimeout>
  detach: () => void // 摘掉中止监听
}

export interface HubState {
  pending: { id: string; kind: RequestKind; proposalId: string | null; pending?: unknown; prompt: string; createdAt: string }[]
  agentWaiting: boolean // 有 agent 正在长轮询等待用户
  waitingAgents: string[] // 正在长轮询等待的席位名列表
  inbox: number // 用户主动发出、agent 还没取走的画有几份
  inboxTargets: string[] // 其中指定了席位的那些，是发给谁的（去重）
  handoff: { from: string; to: string | null; note: string } | null // 尚未被接走的最新一棒
  onlineSeats?: OnlineSeat[] // 当前连着画布的在线 agent 席位
}

// 已经有结果（回应了或取消了）的请求留最近这么多条：agent 可能重复来取同一个结果，
// 但每条都带着整份画布和截图，全留着的话应用开得越久占的内存越多
export const FINISHED_KEEP = 8
export const QUEUE_KEEP = 32

export class RequestHub {
  private requests = new Map<string, DrawRequest>()
  private inbox: Submission[] = []
  private handoffs: Handoff[] = []
  private waiters = new Set<Waiter>()
  private seq = 0
  private listener: ((s: HubState) => void) | null = null
  private evictListener: ((requestId: string) => void) | null = null

  onChange(fn: (s: HubState) => void): void {
    this.listener = fn
  }

  onEvict(fn: (requestId: string) => void): void {
    this.evictListener = fn
  }

  state(): HubState {
    const pending = [...this.requests.values()]
      .filter((r) => r.status === 'waiting')
      .map(({ id, kind, proposalId, pending: pendingChanges, prompt, createdAt }) => ({
        id,
        kind,
        proposalId,
        pending: pendingChanges ?? null,
        prompt,
        createdAt
      }))
    const waitingAgents = [
      ...new Set(
        [...this.waiters]
          .map((w) => ('inbox' in w.target && w.target.agent ? w.target.agent : null))
          .filter((a): a is string => Boolean(a))
      )
    ]
    const lastHandoff = this.handoffs.length ? this.handoffs[this.handoffs.length - 1] : null
    return {
      pending,
      agentWaiting: this.waiters.size > 0,
      waitingAgents,
      inbox: this.inbox.length,
      inboxTargets: [...new Set(this.inbox.map((s) => s.to).filter((t): t is string => Boolean(t)))],
      handoff: lastHandoff ? { from: lastHandoff.from, to: lastHandoff.to, note: lastHandoff.note } : null
    }
  }

  private canTakeHandoff(h: Handoff, agent: string | null | undefined): boolean {
    if (agent && agent === h.from) return false
    if (h.to) return Boolean(agent && agent === h.to)
    return true
  }

  // 一个席位把画笔递给另一个席位：目标已在等待时立即唤醒，否则先挂在画板队列里
  passBaton(h: Handoff): boolean {
    const woke = this.settle((t) => 'inbox' in t && this.canTakeHandoff(h, t.agent), { status: 'handoff', handoff: h }, true)
    if (woke) {
      this.emit()
      return true
    }
    this.handoffs.push(h)
    if (this.handoffs.length > QUEUE_KEEP) this.handoffs.splice(0, this.handoffs.length - QUEUE_KEEP)
    this.emit()
    return false
  }

  // 目标席位来读画板时，顺便取走递给它的画笔
  takeHandoffs(agent: string | null): Handoff[] {
    if (!this.handoffs.length) return []
    const taken: Handoff[] = []
    const kept: Handoff[] = []
    for (const h of this.handoffs) {
      if (this.canTakeHandoff(h, agent)) taken.push(h)
      else kept.push(h)
    }
    if (taken.length) {
      this.handoffs = kept
      this.emit()
    }
    return taken
  }

  // 用户点选了席位的画只交给那个席位；没点选的谁来都能取
  private canTakeSubmission(s: Submission, agent: string | null | undefined): boolean {
    return !s.to || Boolean(agent && agent === s.to)
  }

  // agent 直接读画布时，顺便把收件箱里它能取的都交给它
  takeInbox(agent: string | null = null): Submission[] {
    if (!this.inbox.length) return []
    const taken: Submission[] = []
    const kept: Submission[] = []
    for (const s of this.inbox) {
      if (this.canTakeSubmission(s, agent)) taken.push(s)
      else kept.push(s)
    }
    if (taken.length) {
      this.inbox = kept
      this.emit()
    }
    return taken
  }

  private emit(): void {
    this.listener?.(this.state())
  }

  // 请求有了结果：底稿和待执行的改动用不上了，马上丢掉；再把最早结束的那些请求清掉。
  // 清掉以后 agent 再拿那个 request_id 来等，会得到 unknown_request。
  private finish(req: DrawRequest, status: 'submitted' | 'cancelled', submission: Submission | null): void {
    req.status = status
    req.submission = submission
    req.baseline = null
    req.pending = null
    // 挪到最后，让 Map 里已结束的请求按结束的先后排
    this.requests.delete(req.id)
    this.requests.set(req.id, req)
    const finished = [...this.requests.values()].filter((r) => r.status !== 'waiting')
    for (const old of finished.slice(0, Math.max(0, finished.length - FINISHED_KEEP))) {
      this.requests.delete(old.id)
      this.evictListener?.(old.id)
    }
  }

  // 还在等用户回应的请求，用来存盘
  waiting(): DrawRequest[] {
    return [...this.requests.values()].filter((r) => r.status === 'waiting')
  }

  // 用户主动发出、还没被 agent 取走的画，同样用来存盘防重启丢失
  queuedInbox(): Submission[] {
    return [...this.inbox]
  }

  // 还没被接走的递画笔接力，随 pending.json 存盘
  queuedHandoffs(): Handoff[] {
    return [...this.handoffs]
  }

  // 应用重启后把存盘的请求、收件箱和递画笔交接放回来，编号不变，agent 手里的 request_id 还能用
  restore(saved: readonly DrawRequest[], savedInbox: readonly Submission[] = [], savedHandoffs: readonly Handoff[] = []): void {
    for (const r of saved) {
      if (!r?.id || this.requests.has(r.id)) continue
      this.requests.set(r.id, { ...r, status: 'waiting', submission: null })
    }
    const seenInbox = new Set(this.inbox.map((s) => `${s.at}:${s.version}:${s.note}`))
    for (const s of savedInbox) {
      if (!s || typeof s.sceneJson !== 'string' || typeof s.at !== 'string') continue
      const key = `${s.at}:${s.version}:${s.note ?? ''}`
      if (seenInbox.has(key)) continue
      seenInbox.add(key)
      this.inbox.push({ ...s, requestId: null })
    }
    const seenHandoffs = new Set(this.handoffs.map((h) => `${h.at}:${h.from}:${h.to ?? ''}:${h.note}`))
    for (const h of savedHandoffs) {
      if (!h || typeof h.from !== 'string' || typeof h.sceneJson !== 'string' || typeof h.at !== 'string') continue
      const key = `${h.at}:${h.from}:${h.to ?? ''}:${h.note ?? ''}`
      if (seenHandoffs.has(key)) continue
      seenHandoffs.add(key)
      this.handoffs.push({ ...h, to: h.to || null })
    }
    this.emit()
  }

  create(prompt: string, proposalId: string | null = null, baseline: unknown = null, pending: unknown = null): DrawRequest {
    this.seq += 1
    const req: DrawRequest = {
      id: `req_${Date.now().toString(36)}_${this.seq}`,
      kind: proposalId ? 'proposal' : 'draw',
      proposalId,
      baseline,
      pending,
      prompt,
      createdAt: new Date().toISOString(),
      status: 'waiting',
      submission: null
    }
    this.requests.set(req.id, req)
    this.emit()
    return req
  }

  get(id: string): DrawRequest | undefined {
    return this.requests.get(id)
  }

  // 返回这份画是不是已经有着落：回应了请求，或者直接交到了正在等的 agent 手上。
  // 返回 false 表示进了收件箱，要等 agent 自己来取。
  submit(sub: Submission): boolean {
    const req = sub.requestId ? this.requests.get(sub.requestId) : undefined
    let delivered = true
    if (req && req.status === 'waiting') {
      const submission = { ...sub, to: null }
      this.finish(req, 'submitted', submission)
      this.settle((t) => 'requestId' in t && t.requestId === req.id, { status: 'submitted', submission })
    } else {
      // 主动发送，或者请求已经失效：交给正在等收件箱的 agent（点选了席位就只交给那个席位），没人等就放进收件箱
      const fresh = { ...sub, requestId: null, to: sub.to || null }
      delivered = this.settle((t) => 'inbox' in t && this.canTakeSubmission(fresh, t.agent), { status: 'submitted', submission: fresh }, true)
      if (!delivered) {
        this.inbox.push(fresh)
        if (this.inbox.length > QUEUE_KEEP) this.inbox.splice(0, this.inbox.length - QUEUE_KEEP)
      }
    }
    this.emit()
    return delivered
  }

  cancel(id: string): boolean {
    const req = this.requests.get(id)
    if (!req || req.status !== 'waiting') return false
    this.finish(req, 'cancelled', null)
    this.settle((t) => 'requestId' in t && t.requestId === id, { status: 'cancelled', requestId: id })
    this.emit()
    return true
  }

  // 删除画板时统一清理该画板下未完成的等待请求和收件箱
  cancelAll(): void {
    let changed = false
    for (const req of [...this.requests.values()]) {
      if (req.status !== 'waiting') continue
      this.finish(req, 'cancelled', null)
      this.settle((t) => 'requestId' in t && t.requestId === req.id, { status: 'cancelled', requestId: req.id })
      changed = true
    }
    if (this.settle((t) => 'inbox' in t, { status: 'waiting', waitingFor: 'user' })) {
      changed = true
    }
    if (this.inbox.length) {
      this.inbox = []
      changed = true
    }
    if (this.handoffs.length) {
      this.handoffs = []
      changed = true
    }
    if (changed) this.emit()
  }

  // signal 中止表示等的人已经走了（连接断开或工具调用被取消）：立刻撤下，后来的画和接力棒留在队列里等下一次来取
  wait(target: WaitTarget, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    if (signal?.aborted) return Promise.resolve({ status: 'waiting', waitingFor: 'user' })
    if ('requestId' in target) {
      const req = this.requests.get(target.requestId)
      if (!req) return Promise.resolve({ status: 'unknown_request', requestId: target.requestId })
      if (req.status === 'submitted' && req.submission) return Promise.resolve({ status: 'submitted', submission: req.submission })
      if (req.status === 'cancelled') return Promise.resolve({ status: 'cancelled', requestId: req.id })
    } else {
      const inboxIdx = this.inbox.findIndex((s) => this.canTakeSubmission(s, target.agent))
      if (inboxIdx !== -1) {
        const [submission] = this.inbox.splice(inboxIdx, 1)
        this.emit() // 让画布知道这一份被取走了
        return Promise.resolve({ status: 'submitted', submission })
      }
      const idx = this.handoffs.findIndex((h) => this.canTakeHandoff(h, target.agent))
      if (idx !== -1) {
        const [handoff] = this.handoffs.splice(idx, 1)
        this.emit()
        return Promise.resolve({ status: 'handoff', handoff })
      }
    }

    return new Promise((resolve) => {
      const onAbort = () => {
        if (!this.waiters.delete(waiter)) return
        clearTimeout(waiter.timer)
        resolve({ status: 'waiting', waitingFor: 'user' })
        this.emit()
      }
      const waiter: Waiter = {
        target,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          waiter.detach()
          resolve({ status: 'waiting', waitingFor: 'user' })
          this.emit()
        }, timeoutMs),
        detach: () => signal?.removeEventListener('abort', onAbort)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.add(waiter)
      this.emit()
    })
  }

  // 唤醒匹配的等待者；once 为 true 时只唤醒一个（收件箱里的一条消息只交给一个 agent）
  private settle(match: (t: WaitTarget) => boolean, result: WaitResult, once = false): boolean {
    let woke = false
    for (const w of [...this.waiters]) {
      if (!match(w.target)) continue
      clearTimeout(w.timer)
      w.detach()
      this.waiters.delete(w)
      w.resolve(result)
      woke = true
      if (once) break
    }
    return woke
  }
}
