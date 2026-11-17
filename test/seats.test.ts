import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SEAT_COLORS, SEAT_TTL_MS, SeatRegistry, nextSeatColor } from '../src/main/seats.ts'

test('SeatRegistry 支持连接后立即显示在线席位，并在传入 as 时原地升级而不重复出现', () => {
  const reg = new SeatRegistry()
  let notifications = 0
  reg.onChange(() => {
    notifications += 1
  })

  assert.equal(reg.touch({ bridgeId: 'b1', agent: 'antigravity', now: 1000 }), true)
  assert.equal(reg.touch({ bridgeId: 'b2', agent: 'codex-mcp-client', as: '后端', now: 1000 }), true)

  const boardSeats = new Map<string, string>()
  let list = reg.list({ boardSeats, now: 1100 })
  assert.deepEqual(
    list.map((s) => ({ name: s.name, color: s.color, explicit: s.explicit, drawn: s.drawn })),
    [
      { name: 'antigravity', color: SEAT_COLORS[0], explicit: false, drawn: false },
      { name: '后端', color: SEAT_COLORS[1], explicit: true, drawn: false }
    ]
  )
  // 预览色不应污染当前画板已分配色板
  assert.equal(boardSeats.size, 0)

  // b1 后续带 as: "前端" 读取画布后，原名被替换；再调用不带 as 的 canvas_list 不会退回 antigravity
  assert.equal(reg.touch({ bridgeId: 'b1', agent: 'antigravity', as: '前端', now: 1200 }), true)
  assert.equal(reg.touch({ bridgeId: 'b1', agent: 'antigravity', now: 1300 }), false)

  list = reg.list({ boardSeats, now: 1300 })
  assert.deepEqual(
    list.map((s) => s.name),
    ['前端', '后端']
  )
  assert.equal(notifications, 3)
})

test('SeatRegistry 复用当前画板已落笔颜色，并在离场或超时后清理（等待中的席位不超时）', () => {
  const reg = new SeatRegistry()
  reg.touch({ bridgeId: 'b1', as: '前端', now: 1000 })
  reg.touch({ bridgeId: 'b2', as: '后端', now: 1000 })

  const boardSeats = new Map<string, string>([['后端', '#7048e8']])
  const drawnNames = new Set(['后端'])

  const initial = reg.list({ boardSeats, drawnNames, waitingAgents: ['前端'], now: 1000 })
  assert.deepEqual(initial, [
    { name: '前端', color: '#1971c2', explicit: true, waiting: true, drawn: false },
    { name: '后端', color: '#7048e8', explicit: true, waiting: false, drawn: true }
  ])

  // 超过 TTL：正在等待的「前端」保留，没在等待的「后端」过期清理
  const afterTtl = reg.list({ boardSeats, drawnNames, waitingAgents: ['前端'], now: 1000 + SEAT_TTL_MS + 1 })
  assert.deepEqual(afterTtl.map((s) => s.name), ['前端'])

  // 桥接主动离场立即撤下
  assert.equal(reg.leave('b1'), true)
  assert.deepEqual(reg.list({ boardSeats, drawnNames, now: 2000 + SEAT_TTL_MS }), [])
})

test('新席位的颜色避开画板上还在用的颜色，色板用完才循环', () => {
  assert.equal(nextSeatColor([], 0), SEAT_COLORS[0])
  assert.equal(nextSeatColor([SEAT_COLORS[0]], 1), SEAT_COLORS[1])
  // 画板上只剩第二个席位（第一个席位画的已被删光）：新席位不能再拿到第二种颜色
  assert.equal(nextSeatColor([SEAT_COLORS[1]], 1), SEAT_COLORS[0])
  assert.equal(nextSeatColor([SEAT_COLORS[0], SEAT_COLORS[2]], 2), SEAT_COLORS[1])
  assert.equal(nextSeatColor(SEAT_COLORS, 6), SEAT_COLORS[0])
  assert.equal(nextSeatColor(SEAT_COLORS, 7), SEAT_COLORS[1])
})

test('在线席位的预览色和落笔时实际分到的颜色一致', () => {
  const reg = new SeatRegistry()
  reg.touch({ bridgeId: 'b1', as: '新来的', now: 1000 })
  const boardSeats = new Map([['老席位', SEAT_COLORS[1]]])
  const preview = reg.list({ boardSeats, now: 1000 }).find((s) => s.name === '新来的')
  assert.equal(preview?.color, nextSeatColor(boardSeats.values(), boardSeats.size))
  assert.notEqual(preview?.color, SEAT_COLORS[1])
})
