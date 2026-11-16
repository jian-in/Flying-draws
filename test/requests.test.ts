import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RequestHub, type DrawRequest, type Submission } from '../src/main/requests.ts'

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
