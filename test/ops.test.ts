import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, summarize, type SceneElement } from '../src/main/semantic.ts'
import { detourPath, detourPoint, elementFingerprints, estimateTextWidth, exitPoint, OpsError, placeBlock, planOps, rebaseOps, toProposalPlan, type DrawOp, type FingerprintElement } from '../src/main/ops.ts'

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
  const mine: SceneElement = { id: 'rc', type: 'rectangle', x: 0, y: 200, width: 100, height: 60, customData: { flyingdraws: { author: 'agent' } } }
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
const agent = { customData: { flyingdraws: { author: 'agent', layer: 'final' } } }
const mixed: SceneElement[] = [
  { id: 'u', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 },
  { id: 'ut', type: 'text', x: 10, y: 10, width: 40, height: 20, text: '入口', containerId: 'u' },
  { id: 'a', type: 'rectangle', x: 300, y: 0, width: 100, height: 60, ...agent },
  { id: 'at', type: 'text', x: 310, y: 10, width: 40, height: 20, text: '校验', containerId: 'a', ...agent },
  { id: 'b', type: 'rectangle', x: 600, y: 0, width: 100, height: 60, ...agent },
  { id: 'bt', type: 'text', x: 610, y: 10, width: 40, height: 20, text: '入库', containerId: 'b', ...agent },
  { id: 'e1', type: 'arrow', x: 100, y: 30, width: 200, height: 0, startBinding: { elementId: 'u' }, endBinding: { elementId: 'a' }, endArrowhead: 'arrow' },
  { id: 'e2', type: 'arrow', x: 400, y: 30, width: 200, height: 0, startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' }, endArrowhead: 'arrow', ...agent },
  { id: 'p', type: 'rectangle', x: 900, y: 0, width: 100, height: 60, customData: { flyingdraws: { author: 'agent', layer: 'proposal' } } },
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

test('可以改删用户和别的 agent 画的已确认元素，但不能动还没确认的提议', () => {
  const otherAgent: SceneElement = {
    id: 'other',
    type: 'rectangle',
    x: 0,
    y: 200,
    width: 100,
    height: 60,
    customData: { flyingdraws: { author: 'agent', agent: 'codex', layer: 'final' } }
  }
  const g = buildGraph([...mixed, otherAgent])
  const userPlan = planOps(
    [
      { op: 'update_node', id: 'N1', label: '入口（改）' },
      { op: 'delete_edge', from: 'N1', to: 'N2' },
      { op: 'delete_node', id: 'N5' }
    ],
    g,
    ids()
  )
  assert.deepEqual(userPlan.updates.map((u) => [u.elementId, u.label]), [['u', '入口（改）']])
  assert.deepEqual(userPlan.deletes.sort(), ['e1', 'other'])

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
    customData: { flyingdraws: { author: 'agent', layer: 'proposal' } }
  }
  const g = buildGraph([...existing, proposed])
  assert.deepEqual(
    g.nodes.map((n) => n.proposed),
    [false, false, true]
  )
  assert.match(summarize(g, { board: 't', version: 1 }), /N3 （无文字）矩形【agent 的提议，用户还没确认】/)
})

test('update_text、delete_text 与 delete_strokes 可修改独立文字和手绘笔画', () => {
  const stroke = (id: string, x: number): SceneElement => ({
    id,
    type: 'freedraw',
    x,
    y: 200,
    width: 40,
    height: 40,
    points: [
      [0, 0],
      [40, 40]
    ]
  })
  const scene: SceneElement[] = [
    ...existing,
    { id: 't1', type: 'text', x: 0, y: 80, width: 60, height: 20, text: '备注一', containerId: null },
    { id: 't2', type: 'text', x: 300, y: 80, width: 60, height: 20, text: '备注二', containerId: null },
    { id: 'tp', type: 'text', x: 500, y: 80, width: 60, height: 20, text: '待定', containerId: null, customData: { flyingdraws: { author: 'agent', layer: 'proposal' } } },
    stroke('sg1', 0),
    stroke('sg2', 15),
    stroke('s_single', 500)
  ]
  const g = buildGraph(scene)
  assert.deepEqual(g.notes.map((n) => n.id), ['T1', 'T2', 'T3'])
  assert.deepEqual(g.strokeGroups.map((s) => s.id), ['S1'])
  assert.deepEqual(g.strokes.map((s) => s.id), ['S2'])

  const plan = planOps(
    [
      { op: 'update_text', id: 'T1', text: '已更新备注' },
      { op: 'delete_text', id: 'T2' },
      { op: 'delete_strokes', id: 'S1' },
      { op: 'delete_strokes', id: 'S2' }
    ],
    g,
    ids()
  )
  assert.deepEqual(plan.textEdits, [{ elementId: 't1', text: '已更新备注' }])
  assert.deepEqual(plan.deletes.sort(), ['s_single', 'sg1', 'sg2', 't2'])
  assert.deepEqual(plan.modifiedRefs.sort(), ['s_single', 'sg1', 'sg2', 't1', 't2'])

  assert.throws(() => planOps([{ op: 'update_text', id: 'T1', text: '   ' }], g, ids()), /To remove the text, use delete_text/)
  assert.throws(() => planOps([{ op: 'delete_text', id: 'T3' }], g, ids()), /proposal the user has not answered/)
  assert.throws(() => planOps([{ op: 'delete_text', id: 'T9' }], g, ids()), /unknown text "T9"/)
  assert.throws(() => planOps([{ op: 'delete_strokes', id: 'S9' }], g, ids()), /unknown hand-drawn strokes "S9"/)
})

test('set_style 支持改颜色、填充、形状、大小，并校验合法性与触发文字重排', () => {
  const scene: SceneElement[] = [
    ...mixed,
    { id: 'note1', type: 'text', x: 0, y: 120, width: 60, height: 20, text: '旁注', containerId: null },
    { id: 'f1', type: 'freedraw', x: 400, y: 120, width: 50, height: 10, points: [[0, 0], [50, 0]] }
  ]
  const g = buildGraph(scene)
  const plan = planOps(
    [
      { op: 'set_style', id: 'N1', color: '#E03131', fill: '#FFEC99', shape: 'diamond', width: 180, height: 110 },
      { op: 'set_style', id: 'N2', fill: 'transparent', shape: 'ellipse' },
      { op: 'set_style', from: 'N1', to: 'N2', color: '#2f9e44' },
      { op: 'set_style', id: 'T1', color: '#1971c2' },
      { op: 'set_style', id: 'S1', color: '#9c36b5' }
    ],
    g,
    ids()
  )
  assert.deepEqual(plan.styles, [
    { elementId: 'u', color: '#e03131', fill: '#ffec99', shape: 'diamond', w: 180, h: 110 },
    { elementId: 'a', fill: 'transparent', shape: 'ellipse' },
    { elementId: 'e1', color: '#2f9e44' },
    { elementId: 'note1', color: '#1971c2' },
    { elementId: 'f1', color: '#9c36b5' }
  ])
  // N1 和 N2 都有文字且改了形状/大小，应自动生成 relayout: true 的文字更新
  assert.deepEqual(
    plan.updates.map((u) => [u.elementId, u.label, u.relayout]),
    [
      ['u', '入口', true],
      ['a', '校验', true]
    ]
  )

  assert.throws(() => planOps([{ op: 'set_style', id: 'N1' }], g, ids()), /needs at least one/)
  assert.throws(() => planOps([{ op: 'set_style', id: 'N1', color: 'red' }], g, ids()), /hex color/)
  assert.throws(() => planOps([{ op: 'set_style', id: 'N1', width: 10 }], g, ids()), /between 20 and 4000/)
  assert.throws(() => planOps([{ op: 'set_style', id: 'T1', fill: '#fff' }], g, ids()), /only "color" can be changed/)
  assert.throws(() => planOps([{ op: 'set_style', from: 'N1', to: 'N2', shape: 'diamond' }], g, ids()), /only "color" can be changed/)
  assert.throws(() => planOps([{ op: 'set_style', color: '#000' }], g, ids()), /needs "id"/)
})

test('编号换算覆盖独立文字 T1 和手绘 S1，删除后记进 gone', () => {
  const s = (id: string, x: number): SceneElement => ({
    id,
    type: 'freedraw',
    x,
    y: 300,
    width: 30,
    height: 30,
    points: [[0, 0], [30, 30]]
  })
  const baseEls: SceneElement[] = [
    { id: 't_old', type: 'text', x: 200, y: 0, width: 40, height: 20, text: '原注', containerId: null },
    s('g1', 200),
    s('g2', 210),
    s('s_one', 600)
  ]
  const g0 = buildGraph(baseEls)
  const items0 = [
    ...g0.notes.map(({ id, ref, text }) => ({ id, ref, label: text })),
    ...g0.strokeGroups.map((g) => ({ id: g.id, ref: g.refs[0], label: null })),
    ...g0.strokes.map((st) => ({ id: st.id, ref: st.ref, label: null }))
  ]
  const g1 = buildGraph([
    { id: 't_head', type: 'text', x: 0, y: 0, width: 40, height: 20, text: '插在前面', containerId: null },
    s('g_head1', 0),
    s('g_head2', 10),
    ...baseEls.filter((el) => el.id !== 's_one')
  ])
  const rebased = rebaseOps(
    [
      { op: 'update_text', id: 'T1', text: '新文字' },
      { op: 'set_style', id: 'S1', color: '#e03131' },
      { op: 'delete_strokes', id: 'S2' }
    ],
    items0,
    g1
  )
  assert.deepEqual(rebased.gone, ['S2'])
  assert.deepEqual(rebased.ops[0], { op: 'update_text', id: 'T2', text: '新文字' })
  assert.equal((rebased.ops[1] as { id?: string }).id, 'S2')
  const rebasedPlan = planOps(rebased.ops.slice(0, 2), g1, ids())
  assert.equal(rebasedPlan.textEdits[0].elementId, 't_old')
  assert.deepEqual(rebasedPlan.styles.map((s) => s.elementId).sort(), ['g1', 'g2'])
})

test('toProposalPlan 把改动和删除转为标记框与 pending，新增保持不变', () => {
  const g = buildGraph(mixed)
  const plan = planOps(
    [
      { op: 'add_node', id: 'extra', label: '补充' },
      { op: 'update_node', id: 'N1', label: '入口v2' },
      { op: 'set_style', id: 'N2', color: '#e03131' },
      { op: 'delete_node', id: 'N3' }
    ],
    g,
    ids()
  )
  const elMap = new Map(mixed.map((el) => [el.id, el]))
  const { plan: propPlan, pending } = toProposalPlan(
    plan,
    {
      box: (ref) => {
        const el = elMap.get(ref)
        return el ? { x: el.x, y: el.y, w: el.width, h: el.height } : null
      },
      name: (refs) => {
        const n = g.nodes.find((x) => x.ref === refs[0])
        return n ? `节点「${n.label}」` : '元素'
      }
    },
    ids()
  )
  assert.equal(propPlan.nodes.length, 1)
  assert.deepEqual(propPlan.updates, [])
  assert.deepEqual(propPlan.styles, [])
  assert.deepEqual(propPlan.deletes, [])
  assert.equal(propPlan.markers.length, 3)
  assert.deepEqual(
    propPlan.markers.map((m) => [m.tone, m.note, m.summary]),
    [
      ['change', '改成「入口v2」', '把节点「入口」改成「入口v2」'],
      ['change', '改样式：颜色 #e03131', '把节点「校验」改样式：颜色 #e03131'],
      ['delete', '删除', '删除节点「入库」']
    ]
  )
  assert.ok(pending && pending.updates.length === 1 && pending.styles.length === 1 && pending.deletes.length === 1)

  const pureAdd = planOps([{ op: 'add_node', id: 'only', label: '纯新增' }], g, ids())
  assert.equal(toProposalPlan(pureAdd, { box: () => null, name: () => '' }, ids()).pending, null)
})

// ---------- 找空位落笔 ----------

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })

test('placeBlock：连着已有节点时紧挨着放，横排先试右边、竖排先试下面', () => {
  const anchor = box(0, 0, 100, 60)
  const far = box(0, 2000, 100, 60) // 画布很远的地方还有内容，不该把新的一块甩到它下面去
  const size = { w: 200, h: 80 }
  const right = placeBlock(size, [anchor, far], { anchors: [anchor], direction: 'right', fallback: [0, 9999] })
  assert.deepEqual(right, [200, -10], '右边：隔开一段，上下居中对齐')
  const below = placeBlock(size, [anchor, far], { anchors: [anchor], direction: 'down', fallback: [0, 9999] })
  assert.deepEqual(below, [-50, 160], '下面：隔开一段，左右居中对齐')
})

test('placeBlock：顺着方向的那一侧被占了就换另一侧；两侧都被占就从正下方往下找第一处空位', () => {
  const anchor = box(0, 0, 100, 60)
  const onRight = box(300, 0, 100, 60)
  const size = { w: 200, h: 80 }
  const turned = placeBlock(size, [anchor, onRight], { anchors: [anchor], direction: 'right', fallback: [0, 9999] })
  assert.deepEqual(turned, [-50, 160], '右边有东西，改放下面')

  const under = box(-50, 150, 200, 100)
  const [x, y] = placeBlock(size, [anchor, onRight, under], { anchors: [anchor], direction: 'right', fallback: [0, 9999] })
  assert.equal(x, -50)
  assert.ok(y >= under.y + under.h + 30 && y < 600, '挨着挡路的东西往下放，不是甩到画布最底下')
  for (const o of [anchor, onRight, under]) assert.equal(overlap({ x, y, ...size }, o), false)
})

test('placeBlock：不连已有节点时放进用户视野里的空位；视野里放不下就放在这一竖条内容的下面', () => {
  const view = box(1000, 1000, 800, 500)
  const size = { w: 300, h: 100 }
  assert.deepEqual(placeBlock(size, [], { view, fallback: [0, 9999] }), [1000, 1000], '视野是空的：放在左上角')

  const inView = box(1000, 1000, 400, 200)
  const [x, y] = placeBlock(size, [inView], { view, fallback: [0, 9999] })
  assert.equal(overlap({ x, y, ...size }, inView), false)
  assert.ok(x >= view.x && x + size.w <= view.x + view.w && y >= view.y && y + size.h <= view.y + view.h, '还在视野里')

  const full = box(900, 900, 1000, 700) // 整个视野都被占满
  assert.deepEqual(placeBlock(size, [full], { view, fallback: [0, 9999] }), [1000, 1700])
  assert.deepEqual(placeBlock(size, [full], { fallback: [7, 9999] }), [7, 9999], '不知道视野时用调用方给的老位置')
})

test('planOps：连到已有节点的新节点落在它旁边的空位，而不是所有内容的最下方', () => {
  // N1、N2 在上面一行；很远的下方还有一个用户画的框
  const scene: SceneElement[] = [...existing, { id: 'rc', type: 'rectangle', x: 0, y: 3000, width: 100, height: 60 }]
  const graph = buildGraph(scene)
  const n2 = graph.nodes.find((n) => n.ref === 'rb')!
  const plan = planOps(
    [
      { op: 'add_node', id: 'next', label: '下一步' },
      { op: 'add_edge', from: n2.id, to: 'next' }
    ],
    graph,
    ids()
  )
  const next = plan.nodes[0]
  assert.ok(next.x >= 400 + 60 && next.x < 800, '在 N2 右边不远处')
  assert.ok(next.y < 300, '没有被甩到 y=3000 那个框的下面')
  for (const n of graph.nodes) assert.equal(overlap(next, n.bbox), false)
})

// ---------- 连线绕开障碍 ----------

test('detourPoint：直线不压东西时不加拐点；压到时在旁边加一个拐点，两段线都绕开', () => {
  const a: [number, number] = [0, 0]
  const b: [number, number] = [600, 0]
  assert.equal(detourPoint(a, b, [box(250, 200, 100, 60)]), null)

  const wall = box(250, -30, 100, 60)
  const via = detourPoint(a, b, [wall])
  assert.ok(via, '加了拐点')
  assert.ok(Math.abs(via![0] - 300) < 1, '拐点在两端的中线上')
  assert.ok(via![1] > wall.y + wall.h || via![1] < wall.y, '拐点在障碍的上面或下面')

  // 圈着端点的大框、端点自己的框不算障碍
  assert.equal(detourPoint(a, b, [box(-50, -50, 100, 100), box(550, -50, 100, 100), box(-100, -100, 800, 200)]), null)
})

test('planOps：两个已有节点之间隔着别的节点时，新连线带一个拐点绕过去', () => {
  const scene: SceneElement[] = [
    { id: 'ra', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 },
    { id: 'rm', type: 'rectangle', x: 300, y: 0, width: 100, height: 60 },
    { id: 'rb', type: 'rectangle', x: 600, y: 0, width: 100, height: 60 }
  ]
  const graph = buildGraph(scene)
  const id = (ref: string) => graph.nodes.find((n) => n.ref === ref)!.id
  const plan = planOps([{ op: 'add_edge', from: id('ra'), to: id('rb') }], graph, ids())
  const e = plan.edges[0]
  assert.equal(e.points.length, 3, '起点、拐点、终点')
  const midY = e.y + e.points[1][1]
  assert.ok(midY > 60 + 10 || midY < -10, '拐点在中间那个节点的上方或下方')

  const direct = planOps([{ op: 'add_edge', from: id('ra'), to: id('rm') }], graph, ids())
  assert.equal(direct.edges[0].points.length, 2, '相邻的两个节点之间还是直线')
})

test('detourPath：两处错开障碍挡死单拐点时，退回双拐点平行走廊绕行', () => {
  const a: [number, number] = [0, 0]
  const b: [number, number] = [600, 0]
  // 左右两堵高墙靠近端点，单拐点斜线会擦到墙角，双拐点走廊从上方或下方平直绕过
  const walls = [box(90, -120, 120, 240), box(390, -120, 120, 240)]
  const path = detourPath(a, b, walls)
  assert.ok(path.length >= 1)
  for (const [, py] of path) assert.ok(py > 120 || py < -120)
})

test('elementFingerprints：拖动节点连带拉伸绑定箭头时不误报箭头冲突，真改箭头文字或挪节点本身仍报冲突', () => {
  const before: FingerprintElement[] = [
    { id: 'n1', type: 'rectangle', x: 0, y: 0, width: 100, height: 60, version: 2 },
    { id: 'n2', type: 'rectangle', x: 300, y: 0, width: 100, height: 60, version: 3 },
    {
      id: 'e1',
      type: 'arrow',
      x: 108,
      y: 30,
      width: 184,
      height: 0,
      points: [[0, 0], [184, 0]],
      startBinding: { elementId: 'n1' },
      endBinding: { elementId: 'n2' },
      endArrowhead: 'arrow',
      strokeColor: '#1e1e1e',
      version: 4
    },
    { id: 'e1t', type: 'text', x: 180, y: 20, width: 40, height: 20, containerId: 'e1', text: '通过', version: 1 }
  ]
  // 用户把 n2 往右拖了 80px：n2.version 变了，e1 和 e1t 的坐标与 version 也跟着递增，但箭头语义没变
  const draggedNode: FingerprintElement[] = [
    before[0],
    { ...before[1], x: 380, version: 9 },
    { ...before[2], width: 264, points: [[0, 0], [264, 0]], version: 11 },
    { ...before[3], x: 220, version: 6 }
  ]
  const fp0 = elementFingerprints(before)
  const fpDragged = elementFingerprints(draggedNode)
  assert.notEqual(fp0.get('n2'), fpDragged.get('n2'), '被拖动的节点本身指纹变化，防覆盖用户位置改动')
  assert.equal(fp0.get('e1'), fpDragged.get('e1'), '仅因端点跟随拉伸的绑定箭头指纹不变，不误判冲突')

  // 用户真改了箭头上的文字或样式：指纹变化
  const editedArrowLabel: FingerprintElement[] = [
    before[0],
    before[1],
    before[2],
    { ...before[3], text: '拒绝', version: 2 }
  ]
  assert.notEqual(fp0.get('e1'), elementFingerprints(editedArrowLabel).get('e1'))
})
