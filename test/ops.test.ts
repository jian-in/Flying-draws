import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, summarize, type SceneElement } from '../src/main/semantic.ts'
import { OpsError, planOps, type DrawOp } from '../src/main/ops.ts'

const ids = () => {
  let n = 0
  return () => `new${++n}`
}
const empty = buildGraph([])

// 画板上已有的两个节点：N1 在左，N2 在右
const existing: SceneElement[] = [
  { id: 'ra', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 },
  { id: 'rb', type: 'rectangle', x: 300, y: 0, width: 100, height: 60 }
]

test('空画板上：新节点排成一行，连线从左边节点的右边缘指向右边节点的左边缘', () => {
  const ops: DrawOp[] = [
    { op: 'add_node', id: 'a', label: '开始' },
    { op: 'add_node', id: 'b', label: '结束' },
    { op: 'add_edge', from: 'a', to: 'b', label: '下一步' }
  ]
  const plan = planOps(ops, empty, ids())
  assert.equal(plan.nodes.length, 2)
  const [a, b] = plan.nodes
  assert.equal(a.y, b.y)
  assert.ok(b.x >= a.x + a.w + 40, '两个节点之间留了空')
  const e = plan.edges[0]
  assert.deepEqual([e.fromElementId, e.toElementId, e.label], [a.elementId, b.elementId, '下一步'])
  assert.ok(e.x > a.x + a.w && e.x + e.dx < b.x, '箭头两端都在节点外面')
  assert.equal(e.dy, 0)
  assert.deepEqual(plan.existingRefs, [])
})

test('新节点放在已有内容的下方，不压住用户画的东西', () => {
  const plan = planOps([{ op: 'add_node', id: 'a', label: '新的' }], buildGraph(existing), ids())
  assert.ok(plan.nodes[0].y >= 60 + 50)
  assert.equal(plan.nodes[0].x, 0)
})

test('文字长的节点更宽，菱形比矩形留更多空', () => {
  const plan = planOps(
    [
      { op: 'add_node', id: 'short', label: '好' },
      { op: 'add_node', id: 'long', label: '这是一个相当长的节点标题文字' },
      { op: 'add_node', id: 'ask', label: '这是一个相当长的节点标题文字', shape: 'diamond' }
    ],
    empty,
    ids()
  )
  const [short, long, ask] = plan.nodes
  assert.ok(long.w > short.w)
  assert.ok(ask.w > long.w && ask.h > long.h)
})

test('用 N1 这样的编号连到已有节点，并记下引用了哪些已有元素', () => {
  const plan = planOps(
    [
      { op: 'add_node', id: 'c', label: '第三步' },
      { op: 'add_edge', from: 'N2', to: 'c' },
      { op: 'add_text', text: '这里要确认', near: 'N1' }
    ],
    buildGraph(existing),
    ids()
  )
  assert.equal(plan.edges[0].fromElementId, 'rb')
  assert.deepEqual(plan.existingRefs.sort(), ['ra', 'rb'])
  assert.deepEqual([plan.texts[0].x, plan.texts[0].y > 60], [0, true])
})

test('指令有问题时整批拒绝，错误信息说明是哪一条', () => {
  const g = buildGraph(existing)
  assert.throws(() => planOps([], g, ids()), OpsError)
  assert.throws(() => planOps([{ op: 'add_edge', from: 'a', to: 'N1' }], g, ids()), /ops\[0\]\.from: unknown node "a"/)
  assert.throws(() => planOps([{ op: 'add_node', id: 'N1' }], g, ids()), /already a node on the canvas/)
  assert.throws(
    () =>
      planOps(
        [
          { op: 'add_node', id: 'a' },
          { op: 'add_node', id: 'a' }
        ],
        g,
        ids()
      ),
    /duplicate node id/
  )
  assert.throws(() => planOps([{ op: 'add_edge', from: 'N1', to: 'N1' }], g, ids()), /itself/)
  assert.throws(() => planOps([{ op: 'delete', id: 'N1' } as unknown as DrawOp], g, ids()), /unknown op "delete"/)
})

test('agent 画的元素在摘要里单独标出来', () => {
  const mine: SceneElement = { id: 'rc', type: 'rectangle', x: 0, y: 200, width: 100, height: 60, customData: { sketchlink: { author: 'agent' } } }
  const g = buildGraph([...existing, mine])
  assert.deepEqual(
    g.nodes.map((n) => n.author),
    ['user', 'user', 'agent']
  )
  const s = summarize(g, { board: 't', version: 1 })
  assert.match(s, /N3 （无文字）矩形【agent 画的】/)
  assert.doesNotMatch(s, /N1 .*agent 画的/)
})
