import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, summarize, type SceneElement } from '../src/main/semantic.ts'
import { estimateTextWidth, exitPoint, OpsError, planOps, rebaseOps, type DrawOp } from '../src/main/ops.ts'

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
  const [dx, dy] = e.points[e.points.length - 1]
  assert.equal(e.points.length, 2)
  assert.ok(e.x > a.x + a.w && e.x + dx < b.x, '箭头两端都在节点外面')
  assert.ok(Math.abs(dy) < 0.001, '同一行的两个节点之间是水平线')
  assert.ok(b.x - (a.x + a.w) >= estimateTextWidth('下一步'), '两个节点之间放得下连线上的文字')
  assert.deepEqual(plan.existingRefs, [])
})

const overlap = (p: { x: number; y: number; w: number; h: number }, q: { x: number; y: number; w: number; h: number }) =>
  p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h

test('分支流程：节点互不重叠，同一层的节点上下排开', () => {
  const plan = planOps(
    [
      { op: 'add_node', id: 'ask', label: '已登录？', shape: 'diamond' },
      { op: 'add_node', id: 'home', label: '首页' },
      { op: 'add_node', id: 'login', label: '登录页' },
      { op: 'add_edge', from: 'ask', to: 'home', label: '是' },
      { op: 'add_edge', from: 'ask', to: 'login', label: '否' }
    ],
    empty,
    ids()
  )
  const [ask, home, login] = plan.nodes
  for (const [p, q] of [[ask, home], [ask, login], [home, login]] as const) assert.equal(overlap(p, q), false)
  assert.ok(home.x > ask.x + ask.w && login.x > ask.x + ask.w, '两个分支都在判断节点右边')
  assert.ok(Math.abs(home.x - login.x) < 1 && home.y !== login.y, '两个分支在同一层，上下排开')
})

test('direction: down 时从上往下排', () => {
  const ops: DrawOp[] = [
    { op: 'add_node', id: 'a', label: '第一步' },
    { op: 'add_node', id: 'b', label: '第二步' },
    { op: 'add_edge', from: 'a', to: 'b' }
  ]
  const [a, b] = planOps(ops, empty, ids(), { direction: 'down' }).nodes
  assert.ok(b.y > a.y + a.h)
  assert.ok(Math.abs(a.x - b.x) < 1)
})

test('跨层的连线带拐点，绕开中间的节点', () => {
  const plan = planOps(
    [
      { op: 'add_node', id: 'a', label: 'A' },
      { op: 'add_node', id: 'b', label: 'B' },
      { op: 'add_node', id: 'c', label: 'C' },
      { op: 'add_edge', from: 'a', to: 'b' },
      { op: 'add_edge', from: 'b', to: 'c' },
      { op: 'add_edge', from: 'a', to: 'c', label: '跳过' }
    ],
    empty,
    ids()
  )
  const skip = plan.edges[2]
  assert.ok(skip.points.length > 2)
  const b = plan.nodes[1]
  for (const [px, py] of skip.points) {
    const inside = skip.x + px > b.x && skip.x + px < b.x + b.w && skip.y + py > b.y && skip.y + py < b.y + b.h
    assert.equal(inside, false, '拐点不在中间节点里面')
  }
})

test('箭头从菱形和椭圆的轮廓出发，不是从外接框出发', () => {
  const box = { x: 0, y: 0, w: 200, h: 100 }
  // 朝右下 45° 方向：矩形在角上附近，菱形和椭圆要近得多
  const far = (shape: string) => Math.hypot(...exitPoint({ ...box, shape }, 1100, 1050, 0).map((v, i) => v - [100, 50][i]) as [number, number])
  assert.ok(far('diamond') < far('ellipse') && far('ellipse') < far('rectangle'))
  // 正右方：三种图形都在右边缘
  for (const shape of ['rectangle', 'ellipse', 'diamond']) assert.deepEqual(exitPoint({ ...box, shape }, 500, 50, 8), [208, 50])
})

test('挂在新节点旁边的文字不和别的节点重叠', () => {
  const plan = planOps(
    [
      { op: 'add_node', id: 'ask', label: '已登录？', shape: 'diamond' },
      { op: 'add_node', id: 'home', label: '首页' },
      { op: 'add_node', id: 'login', label: '登录页' },
      { op: 'add_edge', from: 'ask', to: 'home' },
      { op: 'add_edge', from: 'ask', to: 'login' },
      { op: 'add_text', text: '没登录就去登录页，登录完再回来', near: 'home' }
    ],
    empty,
    ids()
  )
  const t = plan.texts[0]
  const home = plan.nodes[1]
  const tb = { x: t.x, y: t.y, w: estimateTextWidth(t.text), h: 25 }
  assert.ok(t.y >= home.y + home.h, '文字在节点下方')
  for (const n of plan.nodes) assert.equal(overlap(tb, n), false, `文字没有压到 ${n.key}`)
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

// 画板：用户的「入口」(N1) → agent 的「校验」(N2) → agent 的「入库」(N3)，外加一个还没确认的提议「缓存」(N4)
const agent = { customData: { sketchlink: { author: 'agent', layer: 'final' } } }
const mixed: SceneElement[] = [
  { id: 'u', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 },
  { id: 'ut', type: 'text', x: 10, y: 10, width: 40, height: 20, text: '入口', containerId: 'u' },
  { id: 'a', type: 'rectangle', x: 300, y: 0, width: 100, height: 60, ...agent },
  { id: 'at', type: 'text', x: 310, y: 10, width: 40, height: 20, text: '校验', containerId: 'a', ...agent },
  { id: 'b', type: 'rectangle', x: 600, y: 0, width: 100, height: 60, ...agent },
  { id: 'bt', type: 'text', x: 610, y: 10, width: 40, height: 20, text: '入库', containerId: 'b', ...agent },
  { id: 'e1', type: 'arrow', x: 100, y: 30, width: 200, height: 0, startBinding: { elementId: 'u' }, endBinding: { elementId: 'a' }, endArrowhead: 'arrow' },
  { id: 'e2', type: 'arrow', x: 400, y: 30, width: 200, height: 0, startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' }, endArrowhead: 'arrow', ...agent },
  { id: 'p', type: 'rectangle', x: 900, y: 0, width: 100, height: 60, customData: { sketchlink: { author: 'agent', layer: 'proposal' } } },
  { id: 'pt', type: 'text', x: 910, y: 10, width: 40, height: 20, text: '缓存', containerId: 'p' }
]

test('改字和删除：只列出要动的元素，级联由页面处理', () => {
  const plan = planOps(
    [
      { op: 'update_node', id: 'N2', label: '校验 token' },
      { op: 'update_edge', from: 'N2', to: 'N3', label: '通过' },
      { op: 'delete_node', id: 'N3' }
    ],
    buildGraph(mixed),
    ids()
  )
  assert.deepEqual(
    plan.updates.map((u) => [u.elementId, u.label]),
    [
      ['a', '校验 token'],
      ['e2', '通过']
    ]
  )
  assert.deepEqual(plan.deletes, ['b'])
  assert.deepEqual(plan.modifiedRefs.sort(), ['a', 'b', 'e2'])
  assert.equal(new Set(plan.updates.map((u) => u.textId)).size, 2)
})

test('不能改用户画的东西，也不能改还没确认的提议', () => {
  const g = buildGraph(mixed)
  assert.throws(() => planOps([{ op: 'delete_node', id: 'N1' }], g, ids()), /node N1 was drawn by the user/)
  assert.throws(() => planOps([{ op: 'update_node', id: 'N1', label: 'x' }], g, ids()), /drawn by the user/)
  assert.throws(() => planOps([{ op: 'delete_edge', from: 'N1', to: 'N2' }], g, ids()), /the arrow from N1 to N2 was drawn by the user/)
  assert.throws(() => planOps([{ op: 'delete_node', id: 'N4' }], g, ids()), /proposal the user has not answered/)
  assert.throws(() => planOps([{ op: 'delete_edge', from: 'N3', to: 'N2' }], g, ids()), /no arrow from N3 to N2/)
  assert.throws(() => planOps([{ op: 'delete_node', id: 'nope' }], g, ids()), /unknown node "nope"/)
})

test('同一批里删掉一个节点又去连它：整批拒绝', () => {
  const ops: DrawOp[] = [
    { op: 'delete_node', id: 'N3' },
    { op: 'add_node', id: 'x', label: '新的' },
    { op: 'add_edge', from: 'x', to: 'N3' }
  ]
  assert.throws(() => planOps(ops, buildGraph(mixed), ids()), /deletes node N3 and also adds an arrow to it/)
})

test('编号换算：画板变了以后，旧编号换成同一个元素现在的编号', () => {
  const before = buildGraph(mixed)
  // 用户在最左边加了一个节点，原来的编号全部往后挪一位
  const after = buildGraph([{ id: 'new', type: 'rectangle', x: -300, y: 0, width: 100, height: 60 }, ...mixed])
  assert.equal(after.nodes.find((n) => n.ref === 'a')?.id, 'N3')
  const { ops, gone } = rebaseOps(
    [
      { op: 'add_node', id: 'x', label: '新的' },
      { op: 'add_edge', from: 'N2', to: 'x' },
      { op: 'update_node', id: 'N2', label: '改了' },
      { op: 'delete_edge', from: 'N2', to: 'N3' },
      { op: 'add_text', text: '注', near: 'N1' }
    ],
    before.nodes,
    after
  )
  assert.deepEqual(gone, [])
  assert.deepEqual(ops, [
    { op: 'add_node', id: 'x', label: '新的' },
    { op: 'add_edge', from: 'N3', to: 'x' },
    { op: 'update_node', id: 'N3', label: '改了' },
    { op: 'delete_edge', from: 'N3', to: 'N4' },
    { op: 'add_text', text: '注', near: 'N2' }
  ])
  // 换算后的指令在新画板上指向的还是原来那个元素
  assert.equal(planOps(ops, after, ids()).updates[0].elementId, 'a')
})

test('编号换算：引用的节点已经被删掉时报出来', () => {
  const before = buildGraph(mixed)
  const after = buildGraph(mixed.filter((el) => el.id !== 'b' && el.id !== 'bt'))
  const { gone } = rebaseOps([{ op: 'add_node', id: 'x' }, { op: 'add_edge', from: 'x', to: 'N3' }], before.nodes, after)
  assert.deepEqual(gone, ['N3'])
})

test('还没确认的提议和已经画上去的分开标', () => {
  const proposed: SceneElement = {
    id: 'rp',
    type: 'rectangle',
    x: 0,
    y: 200,
    width: 100,
    height: 60,
    customData: { sketchlink: { author: 'agent', layer: 'proposal' } }
  }
  const g = buildGraph([...existing, proposed])
  assert.deepEqual(
    g.nodes.map((n) => n.proposed),
    [false, false, true]
  )
  assert.match(summarize(g, { board: 't', version: 1 }), /N3 （无文字）矩形【agent 的提议，用户还没确认】/)
})
