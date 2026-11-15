// agent 的绘图请求和用户的"发送"，以及 agent 端的长轮询等待。
// 不依赖 Electron，可以单独测试。

export interface Submission {
  requestId: string | null // null 表示用户主动发送，不是回应某个请求
  note: string
  sceneJson: string
  pngBase64: string | null
  version: number
  at: string
  decision?: 'accepted' | 'rejected' | null // 只有回应提议时才有
  changes?: string[] | null // 回应提议时：用户在提议上改了什么（中文句子）
}

export type RequestKind = 'draw' | 'proposal' // draw：请用户画；proposal：agent 画了提议，请用户确认

export interface DrawRequest {
  id: string
  kind: RequestKind
  proposalId: string | null // 提议层元素上打的标记，页面靠它找到这批元素
  baseline: unknown // 提议画上去时的底稿，用户表态时拿来比出改了什么；这里不关心它的结构
  prompt: string
  createdAt: string
  status: 'waiting' | 'submitted' | 'cancelled'
  submission: Submission | null
}

export type WaitResult =
  | { status: 'submitted'; submission: Submission }
  | { status: 'cancelled'; requestId: string }
  | { status: 'waiting'; waitingFor: 'user' }
  | { status: 'unknown_request'; requestId: string }

export type WaitTarget = { requestId: string } | { inbox: true }

interface Waiter {
  target: WaitTarget
  resolve: (r: WaitResult) => void
  timer: ReturnType<typeof setTimeout>
}

export interface HubState {
  pending: { id: string; kind: RequestKind; proposalId: string | null; prompt: string; createdAt: string }[]
  agentWaiting: boolean // 有 agent 正在长轮询等待用户
  inbox: number // 用户主动发出、agent 还没取走的画有几份
}

export class RequestHub {
  private requests = new Map<string, DrawRequest>()
  private inbox: Submission[] = []
  private waiters = new Set<Waiter>()
  private seq = 0
  private listener: ((s: HubState) => void) | null = null

  onChange(fn: (s: HubState) => void): void {
    this.listener = fn
  }

  state(): HubState {
    const pending = [...this.requests.values()]
      .filter((r) => r.status === 'waiting')
      .map(({ id, kind, proposalId, prompt, createdAt }) => ({ id, kind, proposalId, prompt, createdAt }))
    return { pending, agentWaiting: this.waiters.size > 0, inbox: this.inbox.length }
  }

  // agent 直接读画布时，顺便把收件箱里还没取走的都交给它
  takeInbox(): Submission[] {
    if (!this.inbox.length) return []
    const taken = this.inbox
    this.inbox = []
    this.emit()
    return taken
  }

  private emit(): void {
    this.listener?.(this.state())
  }

  // 还在等用户回应的请求，用来存盘
  waiting(): DrawRequest[] {
    return [...this.requests.values()].filter((r) => r.status === 'waiting')
  }

  // 应用重启后把存盘的请求放回来，编号不变，agent 手里的 request_id 还能用
  restore(saved: readonly DrawRequest[]): void {
    for (const r of saved) {
      if (!r?.id || this.requests.has(r.id)) continue
      this.requests.set(r.id, { ...r, status: 'waiting', submission: null })
    }
    this.emit()
  }

  create(prompt: string, proposalId: string | null = null, baseline: unknown = null): DrawRequest {
    this.seq += 1
    const req: DrawRequest = {
      id: `req_${Date.now().toString(36)}_${this.seq}`,
      kind: proposalId ? 'proposal' : 'draw',
      proposalId,
      baseline,
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

  submit(sub: Submission): void {
    const req = sub.requestId ? this.requests.get(sub.requestId) : undefined
    if (req && req.status === 'waiting') {
      req.status = 'submitted'
      req.submission = sub
      this.settle((t) => 'requestId' in t && t.requestId === req.id, { status: 'submitted', submission: sub })
    } else {
      // 主动发送，或者请求已经失效：放进收件箱，交给等收件箱的 agent
      const fresh = { ...sub, requestId: null }
      if (!this.settle((t) => 'inbox' in t, { status: 'submitted', submission: fresh }, true)) this.inbox.push(fresh)
    }
    this.emit()
  }

  cancel(id: string): boolean {
    const req = this.requests.get(id)
    if (!req || req.status !== 'waiting') return false
    req.status = 'cancelled'
    this.settle((t) => 'requestId' in t && t.requestId === id, { status: 'cancelled', requestId: id })
    this.emit()
    return true
  }

  wait(target: WaitTarget, timeoutMs: number): Promise<WaitResult> {
    if ('requestId' in target) {
      const req = this.requests.get(target.requestId)
      if (!req) return Promise.resolve({ status: 'unknown_request', requestId: target.requestId })
      if (req.status === 'submitted' && req.submission) return Promise.resolve({ status: 'submitted', submission: req.submission })
      if (req.status === 'cancelled') return Promise.resolve({ status: 'cancelled', requestId: req.id })
    } else if (this.inbox.length) {
      const submission = this.inbox.shift()!
      this.emit() // 让画布知道这一份被取走了
      return Promise.resolve({ status: 'submitted', submission })
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        target,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          resolve({ status: 'waiting', waitingFor: 'user' })
          this.emit()
        }, timeoutMs)
      }
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
      this.waiters.delete(w)
      w.resolve(result)
      woke = true
      if (once) break
    }
    return woke
  }
}
