import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RequestHub, type DrawRequest, type Handoff, type Submission } from '../src/main/requests.ts'

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
