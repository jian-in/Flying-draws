import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FINISHED_KEEP, pickupHint, RequestHub, type DrawRequest, type Handoff, type Submission } from '../src/main/requests.ts'

function sampleSubmission(overrides: Partial<Submission> = {}): Submission {
  return {
    requestId: null,
    note: '画好了',
    sceneJson: '{"elements":[]}',
    pngBase64: null,
    version: 3,
    at: '2026-11-15T12:00:00.000Z',
    ...overrides
  }
}

test('RequestHub.restore 同时恢复等待中的请求和收件箱并去重/过滤脏数据', () => {
  const hub = new RequestHub()
  const sub = sampleSubmission()
  const req: DrawRequest = {
    id: 'req_saved_1',
    kind: 'draw',
    proposalId: null,
    baseline: null,
    prompt: '请画架构图',
    createdAt: '2026-11-15T11:59:00.000Z',
    status: 'waiting',
    submission: null
  }

  hub.restore(
    [req, req],
    [
      sub,
      sub, // 重复条目应去重
      { requestId: null, note: 'bad', sceneJson: null as unknown as string, pngBase64: null, version: 1, at: '2026' }
    ]
  )

  const state = hub.state()
  assert.equal(state.pending.length, 1)
  assert.equal(state.pending[0].id, 'req_saved_1')
  assert.equal(state.inbox, 1)
  assert.equal(hub.queuedInbox().length, 1)
  assert.equal(hub.queuedInbox()[0].note, '画好了')
})

test('takeInbox 与 wait({ inbox: true }) 能按序消费恢复后的收件箱消息', async () => {
  const hub = new RequestHub()
  const first = sampleSubmission({ note: '第一份', version: 2, at: '2026-11-15T12:00:00.000Z' })
  const second = sampleSubmission({ note: '第二份', version: 3, at: '2026-11-15T12:01:00.000Z' })
  hub.restore([], [first, second])

  const waited = await hub.wait({ inbox: true }, 50)
  assert.equal(waited.status, 'submitted')
  if (waited.status === 'submitted') assert.equal(waited.submission.note, '第一份')
  assert.equal(hub.state().inbox, 1)

  const taken = hub.takeInbox()
  assert.equal(taken.length, 1)
  assert.equal(taken[0].note, '第二份')
  assert.equal(hub.state().inbox, 0)
  assert.deepEqual(hub.queuedInbox(), [])
})

test('cancelAll 取消等待请求并清空收件箱，同时唤醒正在等待的 requestId', async () => {
  const hub = new RequestHub()
  const req = hub.create('请画流程图')
  hub.submit(sampleSubmission({ note: '顺带发一张' }))
  assert.equal(hub.state().inbox, 1)

  const waiting = hub.wait({ requestId: req.id }, 2000)
  hub.cancelAll()

  const result = await waiting
  assert.deepEqual(result, { status: 'cancelled', requestId: req.id })
  assert.equal(hub.waiting().length, 0)
  assert.equal(hub.queuedInbox().length, 0)
  assert.equal(hub.state().inbox, 0)
})

function sampleHandoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    from: '前端',
    to: '后端',
    note: '上半部分画好了，请你补接口',
    sceneJson: '{"elements":[]}',
    pngBase64: null,
    version: 5,
    at: '2026-11-16T14:00:00.000Z',
    ...overrides
  }
}

test('passBaton 立即唤醒正在等待的目标席位，并阻止发送方自己误接', async () => {
  const hub = new RequestHub()
  const selfWait = hub.wait({ inbox: true, agent: '前端' }, 80)
  const peerWait = hub.wait({ inbox: true, agent: '后端' }, 2000)

  assert.deepEqual(hub.state().waitingAgents.sort(), ['前端', '后端'])

  const delivered = hub.passBaton(sampleHandoff())
  assert.equal(delivered, true)

  const peerRes = await peerWait
  assert.equal(peerRes.status, 'handoff')
  if (peerRes.status === 'handoff') {
    assert.equal(peerRes.handoff.from, '前端')
    assert.equal(peerRes.handoff.note, '上半部分画好了，请你补接口')
  }
  const selfRes = await selfWait
  assert.equal(selfRes.status, 'waiting')
})

test('等待被中止（调用方断开或取消）后立即撤下：之后递来的画笔和用户发的画留在队列里，不交给已经走掉的等待', async () => {
  const hub = new RequestHub()
  const abort = new AbortController()
  const gone = hub.wait({ inbox: true, agent: '后端' }, 5000, abort.signal)
  assert.deepEqual(hub.state().waitingAgents, ['后端'])

  abort.abort()
  assert.equal((await gone).status, 'waiting')
  assert.deepEqual(hub.state().waitingAgents, [])

  // 中止之后递来的画笔进队列，而不是被那个已经走掉的等待接走
  assert.equal(hub.passBaton(sampleHandoff()), false)
  const next = await hub.wait({ inbox: true, agent: '后端' }, 50)
  assert.equal(next.status, 'handoff')

  // 用户点「发给 agent」也一样：留在收件箱里
  const abort2 = new AbortController()
  const gone2 = hub.wait({ inbox: true, agent: null }, 5000, abort2.signal)
  abort2.abort()
  await gone2
  assert.equal(hub.submit({ requestId: null, sceneJson: '{}', pngBase64: null, version: 3, note: '', at: new Date().toISOString() }), false)
  assert.equal(hub.takeInbox().length, 1)

  // 已经中止的信号直接返回，不登记等待
  const pre = new AbortController()
  pre.abort()
  assert.equal((await hub.wait({ inbox: true, agent: '后端' }, 5000, pre.signal)).status, 'waiting')
  assert.deepEqual(hub.state().waitingAgents, [])
})

test('passBaton 未立即送达时入队并可通过 takeHandoffs / wait / restore 接手', async () => {
  const hub = new RequestHub()
  const h1 = sampleHandoff({ from: '前端', to: '后端', note: '给后端的一棒' })
  const h2 = sampleHandoff({ from: '前端', to: null, note: '给任意其他席位', at: '2026-11-16T14:01:00.000Z' })

  assert.equal(hub.passBaton(h1), false)
  assert.equal(hub.passBaton(h2), false)
  assert.equal(hub.queuedHandoffs().length, 2)
  assert.deepEqual(hub.state().handoff, { from: '前端', to: null, note: '给任意其他席位' })

  // 发送方自己来 wait / takeHandoffs 不会取走自己的画笔
  assert.equal(hub.takeHandoffs('前端').length, 0)
  assert.equal((await hub.wait({ inbox: true, agent: '前端' }, 30)).status, 'waiting')

  // 后端来 wait 会先取走指定给它的 h1
  const waited = await hub.wait({ inbox: true, agent: '后端' }, 50)
  assert.equal(waited.status, 'handoff')
  if (waited.status === 'handoff') assert.equal(waited.handoff.note, '给后端的一棒')
  assert.equal(hub.queuedHandoffs().length, 1)

  // restore 恢复剩余的交接，并能由任意其他席位（如 codex）经 takeHandoffs 接手
  const restored = new RequestHub()
  restored.restore([], [], hub.queuedHandoffs())
  const taken = restored.takeHandoffs('codex')
  assert.equal(taken.length, 1)
  assert.equal(taken[0].note, '给任意其他席位')
  assert.equal(restored.state().handoff, null)
})

test('点选了席位的画只交给那个席位：别的席位读不走、等不到', async () => {
  const hub = new RequestHub()
  assert.equal(hub.submit(sampleSubmission({ note: '给接口组的', to: '接口组' })), false)
  assert.deepEqual(hub.state().inboxTargets, ['接口组'])

  assert.deepEqual(hub.takeInbox('架构组'), [])
  assert.deepEqual(hub.takeInbox(), [])
  const other = await hub.wait({ inbox: true, agent: '架构组' }, 20)
  assert.equal(other.status, 'waiting')
  assert.equal(hub.state().inbox, 1)

  const mine = await hub.wait({ inbox: true, agent: '接口组' }, 20)
  assert.equal(mine.status, 'submitted')
  if (mine.status === 'submitted') assert.equal(mine.submission.note, '给接口组的')
  assert.equal(hub.state().inbox, 0)
  assert.deepEqual(hub.state().inboxTargets, [])
})

test('点选的席位正在等时直接送达；只有别的席位在等时进收件箱，没点选的仍交给任意等待者', async () => {
  const hub = new RequestHub()
  const boss = hub.wait({ inbox: true, agent: '架构组' }, 200)
  // 架构组在等，但这份是给接口组的：不能交给架构组
  assert.equal(hub.submit(sampleSubmission({ note: '给接口组的', to: '接口组' })), false)
  assert.equal(hub.state().inbox, 1)

  const second = hub.wait({ inbox: true, agent: '接口组' }, 200)
  const got = await second
  assert.equal(got.status, 'submitted')

  // 没点选席位的，交给还在等的架构组
  assert.equal(hub.submit(sampleSubmission({ note: '给大家的', at: '2026-11-16T08:00:00.000Z' })), true)
  const bossGot = await boss
  assert.equal(bossGot.status, 'submitted')
  if (bossGot.status === 'submitted') assert.equal(bossGot.submission.note, '给大家的')

  // 接口组正在等时点选接口组：直接送达，不进收件箱
  const again = hub.wait({ inbox: true, agent: '接口组' }, 200)
  assert.equal(hub.submit(sampleSubmission({ note: '再给接口组', to: '接口组', at: '2026-11-16T08:01:00.000Z' })), true)
  assert.equal((await again).status, 'submitted')
  assert.equal(hub.state().inbox, 0)
})

test('takeInbox 按席位取：拿走发给自己的和没点选的，留下发给别人的；重启恢复后目标席位不丢', () => {
  const hub = new RequestHub()
  hub.restore(
    [],
    [
      sampleSubmission({ note: '给大家的', at: '2026-11-16T08:00:00.000Z' }),
      sampleSubmission({ note: '给接口组的', to: '接口组', at: '2026-11-16T08:01:00.000Z' }),
      sampleSubmission({ note: '给架构组的', to: '架构组', at: '2026-11-16T08:02:00.000Z' })
    ]
  )
  assert.deepEqual(hub.takeInbox('架构组').map((s) => s.note), ['给大家的', '给架构组的'])
  assert.deepEqual(hub.queuedInbox().map((s) => [s.note, s.to]), [['给接口组的', '接口组']])
})

test('回应请求时不带目标席位，并算作已送达', () => {
  const hub = new RequestHub()
  const req = hub.create('请画流程图')
  assert.equal(hub.submit(sampleSubmission({ requestId: req.id, to: '接口组' })), true)
  assert.equal(hub.get(req.id)?.submission?.to, null)
})

test('pickupHint 写清画板、版本、目标席位和取画方式', () => {
  assert.equal(
    pickupHint({ board: 'login-flow', title: '登录流程', version: 6, to: '接口组' }),
    '我在 Flying draws 画板「登录流程」（login-flow）上画好了（v6），发给席位「接口组」。请调用 canvas_read（board: "login-flow"，as: "接口组"）来取。'
  )
  assert.equal(pickupHint({ board: 'default', version: 2 }), '我在 Flying draws 画板「default」上画好了（v2）。请调用 canvas_read（board: "default"）来取。')
})

test('已结束的请求只留最近几条，底稿和待执行改动在有结果后立刻丢掉', async () => {
  const hub = new RequestHub()
  const ids: string[] = []
  for (let i = 0; i < FINISHED_KEEP + 3; i += 1) {
    const req = hub.create(`第 ${i} 个提议`, `prop_${i}`, { big: 'baseline' }, { big: 'pending' })
    ids.push(req.id)
    if (i % 2) hub.cancel(req.id)
    else hub.submit(sampleSubmission({ requestId: req.id, decision: 'accepted' }))
  }

  // 最早结束的三条被清掉，再来等会被告知不认识这个请求
  for (const id of ids.slice(0, 3)) {
    assert.equal(hub.get(id), undefined)
    assert.deepEqual(await hub.wait({ requestId: id }, 10), { status: 'unknown_request', requestId: id })
  }
  // 留下的还能重复取到结果，但不再带着底稿和待执行改动
  for (const id of ids.slice(3)) {
    const kept = hub.get(id)
    assert.ok(kept)
    assert.equal(kept.baseline, null)
    assert.equal(kept.pending, null)
    const res = await hub.wait({ requestId: id }, 10)
    assert.ok(res.status === 'submitted' || res.status === 'cancelled')
  }
})

test('还在等用户回应的请求不会被清理，不管后面结束了多少个', async () => {
  const hub = new RequestHub()
  const waiting = hub.create('请画架构图', 'prop_keep', { base: 1 }, { change: 1 })
  for (let i = 0; i < FINISHED_KEEP * 2; i += 1) hub.cancel(hub.create(`临时 ${i}`).id)

  assert.deepEqual(hub.waiting().map((r) => r.id), [waiting.id])
  assert.deepEqual(hub.get(waiting.id)?.baseline, { base: 1 })
  assert.deepEqual(hub.get(waiting.id)?.pending, { change: 1 })

  // 删画板时一次取消很多个，同样只留最近几条
  const many = Array.from({ length: FINISHED_KEEP + 2 }, (_, i) => hub.create(`批量 ${i}`).id)
  hub.cancelAll()
  assert.equal(hub.waiting().length, 0)
  assert.equal(many.filter((id) => hub.get(id)).length, FINISHED_KEEP)
})
