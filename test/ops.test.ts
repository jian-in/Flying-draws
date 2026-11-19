import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, summarize, type SceneElement } from '../src/main/semantic.ts'
import { detourPath, detourPoint, elementFingerprints, estimateTextWidth, exitPoint, OpsError, placeBeside, placeBlock, planOps, rebaseOps, toProposalPlan, type DrawOp, type FingerprintElement, type MoveSide } from '../src/main/ops.ts'

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

test('elementFingerprints 忽略提议挂接抬升的版本号，并识别几何、标签、样式和图片内容变化', () => {
  const node: FingerprintElement = { ...existing[0], version: 3, strokeColor: '#222222', backgroundColor: 'transparent' }
  const label: FingerprintElement = { id: 'label', type: 'text', x: 10, y: 15, width: 80, height: 25, text: '入口', fontSize: 20, containerId: node.id }
  const stroke: FingerprintElement = { id: 'stroke', type: 'freedraw', x: 0, y: 80, width: 100, height: 40, points: [[0, 0], [50, 30], [100, 40]] }
  const image: FingerprintElement = { id: 'image', type: 'image', x: 100, y: 80, width: 100, height: 40, fileId: 'file1' }
  const elements = [node, label, stroke, image]
  const before = elementFingerprints(elements)
  const attached = { ...node, version: 4, boundElements: [{ id: 'draft-arrow', type: 'arrow' }] }
  const rejected = { ...node, version: 5, boundElements: [] }
  for (const changed of [attached, rejected]) {
    assert.deepEqual(elementFingerprints([changed, { ...label, version: 7 }, stroke, image]), before)
  }
  const contentChanges: FingerprintElement[] = [
    { ...node, x: 30 }, { ...node, width: 160 }, { ...node, angle: Math.PI / 2 },
    { ...node, backgroundColor: '#ffeeaa', fillStyle: 'solid' }, { ...node, strokeWidth: 3 },
    { ...label, text: '登录' }, { ...label, strokeColor: '#eeeeee' }, { ...label, fontSize: 24 },
    { ...stroke, points: [[0, 0], [50, 10], [100, 40]] }, { ...image, fileId: 'file2' }
  ]
  for (const changed of contentChanges) {
    const after = elementFingerprints(elements.map((el) => el.id === changed.id ? changed : el))
    assert.notEqual(after.get(changed.id), before.get(changed.id))
    if (changed.id === label.id) assert.notEqual(after.get(node.id), before.get(node.id))
  }
})

test('move：绝对坐标和单轴相对位移保留小数，短号与稳定 id 分别登记', () => {
  const plan = planOps([
    { op: 'move', id: 'N1', x: -30.5, y: 15 },
    { op: 'move', id: 'rb', dy: 60.25 }
  ], buildGraph(existing), ids())
  assert.deepEqual(plan.moves.map(({ targetKey, fromBbox, toBbox, dx, dy }) => ({ targetKey, fromBbox, toBbox, dx, dy })), [
    { targetKey: 'ra', fromBbox: box(0, 0, 100, 60), toBbox: box(-30.5, 15, 100, 60), dx: -30.5, dy: 15 },
    { targetKey: 'rb', fromBbox: box(300, 0, 100, 60), toBbox: box(300, 60.25, 100, 60), dx: 0, dy: 60.25 }
  ])
  assert.deepEqual(plan.existingRefs, ['ra'])
  assert.deepEqual(plan.stableRefs, ['rb'])
  assert.deepEqual(plan.modifiedRefs, ['ra', 'rb'])
  assert.deepEqual(plan.targetGroups, [['ra'], ['rb']])
  assert.deepEqual(plan.moves[0].toTopLeft, { x: -30.5, y: 15 })
  assert.equal(Object.hasOwn(plan.moves[1], 'toTopLeft'), false)
})

test('move：near 的四个方向、默认位置和按顺序读取已移动的锚点', () => {
  const graph = buildGraph(existing)
  const expected: Record<MoveSide, [number, number]> = { right: [410, 0], left: [190, 0], below: [300, 70], above: [300, -70] }
  for (const [side, [x, y]] of Object.entries(expected) as [MoveSide, [number, number]][]) {
    const plan = planOps([{ op: 'move', id: 'N1', near: 'rb', side, gap: 10 }], graph, ids())
    assert.deepEqual(plan.moves[0].toBbox, box(x, y, 100, 60), side)
    assert.deepEqual(plan.moves[0].toTopLeft, { x, y }, side)
    assert.deepEqual(plan.stableRefs, ['rb'])
    assert.deepEqual(plan.modifiedRefs, ['ra'])
  }
  const linked = planOps([
    { op: 'move', id: 'N2', dx: 100, dy: 50 },
    { op: 'move', id: 'N1', near: 'N2' }
  ], graph, ids())
  assert.deepEqual(linked.moves[1].toBbox, box(540, 50, 100, 60))
})

test('move：拒绝缺失或混用的位置、非法数字、越界结果及无效目标', () => {
  type Move = Extract<DrawOp, { op: 'move' }>
  const graph = buildGraph([
    ...existing,
    { id: 'proposal', type: 'rectangle', x: 600, y: 0, width: 100, height: 60, customData: { flyingdraws: { layer: 'proposal' } } },
    { id: 'line', type: 'line', x: 100, y: 100, width: 75, height: 0, points: [[0, 0], [75, 0]] },
    { id: 'arrow', type: 'arrow', x: 100, y: 30, width: 200, height: 0, startBinding: { elementId: 'ra' }, endBinding: { elementId: 'rb' } }
  ])
  const invalid: [Partial<Move>, RegExp][] = [
    [{}, /exactly one/],
    [{ x: 10 }, /provided together/],
    [{ y: 10 }, /provided together/],
    [{ x: 10, y: 10, dx: 0 }, /exactly one/],
    [{ near: 'N2', dy: 1 }, /exactly one/],
    [{ near: 'N2', x: 10, y: 10 }, /exactly one/],
    [{ near: '' }, /non-empty id/],
    [{ near: 'N2', side: 'diagonal' as MoveSide }, /side must be/],
    [{ near: 'N2', gap: -1 }, /between 0 and 400/],
    [{ near: 'N2', gap: 401 }, /between 0 and 400/],
    [{ near: 'N2', gap: NaN }, /between 0 and 400/],
    [{ dx: 3, gap: 0 }, /require near/],
    [{ x: NaN, y: 0 }, /x must be a finite number/],
    [{ dx: Infinity }, /dx must be a finite number/],
    [{ dy: -1_000_001 }, /dy must be a finite number/],
    [{ id: 'N2', dx: 1_000_000 }, /destination x/],
    [{ id: 'N2', x: -1_000_000, y: 0 }, /resulting dx/],
    [{ near: 'ra' }, /own target/],
    [{ id: 'missing', dx: 1 }, /unknown element/],
    [{ id: 'proposal', dx: 1 }, /proposal the user has not answered/],
    [{ id: 'arrow', dx: 1 }, /line or arrow/],
    [{ id: 'line', dx: 1 }, /line or arrow/],
    [{ near: 'arrow' }, /line or arrow/]
  ]
  for (const [fields, error] of invalid) {
    assert.throws(() => planOps([{ op: 'move', id: 'N1', ...fields }], graph, ids()), error)
  }
  assert.equal(planOps([{ op: 'move', id: 'N1', x: 1_000_000, y: 0 }], graph, ids()).moves[0].toBbox.x, 1_000_000)
  assert.throws(() => planOps([{ op: 'move', id: 'N1', dx: 1 }, { op: 'move', id: 'ra', dy: 1 }], graph, ids()), /already moved/)
  assert.throws(() => planOps([{ op: 'move', id: 'ra', dx: 1 }, { op: 'delete_node', id: 'N1' }], graph, ids()), /deletes element "ra" and also moves it/)
  assert.throws(() => planOps([{ op: 'delete_node', id: 'N2' }, { op: 'move', id: 'N1', near: 'rb' }], graph, ids()), /near anchor .* is deleted/)
})

test('所有引用路径均拒绝未决提议节点、文字、连线、笔画和图片', () => {
  const proposed = { customData: { flyingdraws: { layer: 'proposal' } } }
  const elements: SceneElement[] = [
    ...existing,
    { id: 'draft-node', type: 'rectangle', x: 600, y: 0, width: 100, height: 60, ...proposed },
    { id: 'draft-text', type: 'text', x: 600, y: 120, width: 80, height: 25, text: '待定', ...proposed },
    { id: 'draft-arrow', type: 'arrow', x: 100, y: 30, width: 200, height: 0, startBinding: { elementId: 'ra' }, endBinding: { elementId: 'rb' }, ...proposed },
    { id: 'draft-stroke', type: 'freedraw', x: 610, y: 210, width: 20, height: 20, points: [[0, 0], [20, 20]], ...proposed },
    { id: 'settled-stroke', type: 'freedraw', x: 615, y: 215, width: 20, height: 20, points: [[0, 0], [20, 20]] },
    { id: 'draft-image', type: 'image', x: 900, y: 100, width: 100, height: 60, fileId: 'file', ...proposed }
  ]
  const graph = buildGraph(elements)
  const drafts: DrawOp[] = [
    { op: 'update_edge', from: 'N1', to: 'N2', label: '改字' }, { op: 'delete_edge', from: 'N1', to: 'N2' },
    { op: 'set_style', from: 'N1', to: 'N2', color: '#123' }
  ]
  for (const id of ['N3', 'draft-node']) drafts.push(
    { op: 'add_edge', from: 'N1', to: id },
    { op: 'add_edge', from: id, to: 'N1' },
    { op: 'update_edge', from: 'N1', to: id, label: '改字' },
    { op: 'delete_edge', from: id, to: 'N1' },
    { op: 'add_text', text: '旁注', near: id },
    { op: 'update_node', id, label: '改字' },
    { op: 'delete_node', id },
    { op: 'set_style', id, color: '#123' },
    { op: 'move', id: 'N1', near: id }
  )
  for (const id of ['T1', 'draft-text']) drafts.push(
    { op: 'update_text', id, text: '改字' }, { op: 'delete_text', id }, { op: 'set_style', id, color: '#123' }
  )
  for (const id of ['S1', 'draft-stroke']) drafts.push(
    { op: 'delete_strokes', id }, { op: 'set_style', id, color: '#123' }, { op: 'move', id, dx: 5 }
  )
  for (const id of ['I1', 'draft-image']) drafts.push(
    { op: 'move', id, dx: 5 },
    { op: 'trace_image', image: id, space: { w: 100, h: 60 }, elements: [{ kind: 'box', x: 0, y: 0, w: 10, h: 10 }] }
  )
  for (const op of drafts) {
    assert.throws(() => planOps([op], graph, ids(), { elements }), /proposal the user has not answered.*canvas_wait/, JSON.stringify(op))
  }
  assert.deepEqual(planOps([{ op: 'move', id: 'settled-stroke', dx: 5 }], graph, ids(), { elements }).moves[0].elementIds, ['settled-stroke'])
})

test('move：S 组保持统一位移，稳定笔画 id 只指一笔，文字和图片独立移动', () => {
  const elements: SceneElement[] = [
    { id: 'f1', type: 'freedraw', x: -26, y: 30, width: 20, height: 20, points: [[0, 0], [-20, -20]] },
    { id: 'f2', type: 'freedraw', x: -22, y: 34, width: 20, height: 20, points: [[0, 0], [-20, -20]] },
    { id: 'text', type: 'text', x: 150, y: 110, width: 40, height: 24, text: '旁注' },
    { id: 'image', type: 'image', x: 140, y: 90, width: 100, height: 60, fileId: 'file' }
  ]
  const graph = buildGraph(elements)
  assert.deepEqual(graph.strokeGroups[0].refs, ['f1', 'f2'])
  const moved = planOps([
    { op: 'move', id: 'S1', x: -10, y: 20 },
    { op: 'move', id: 'T1', dx: 10 },
    { op: 'move', id: 'I1', dy: 120 }
  ], graph, ids(), { elements })
  assert.deepEqual(moved.moves.map(({ kind, elementIds, dx, dy }) => [kind, elementIds, dx, dy]), [
    ['strokes', ['f1', 'f2'], 36, 10], ['text', ['text'], 10, 0], ['image', ['image'], 0, 120]
  ])
  assert.deepEqual(moved.modifiedRefs, ['f1', 'f2', 'text', 'image'])
  const single = planOps([{ op: 'move', id: 'f2', x: -120, y: -50 }], graph, ids(), { elements })
  assert.deepEqual(single.moves[0].fromBbox, box(-42, 14, 20, 20))
  assert.deepEqual(single.moves[0].elementIds, ['f2'])
  assert.deepEqual(single.stableRefs, ['f2'])
  assert.throws(() => planOps([{ op: 'move', id: 'S1', dx: 1 }, { op: 'move', id: 'f2', dy: 1 }], graph, ids(), { elements }), /already moved/)
})

test('placeBeside：屏蔽包含锚点中心的框，先横切滑动，再外推和回退', () => {
  const anchor = box(0, 0, 100, 100)
  const size = { w: 20, h: 20 }
  const outer = box(-100, -100, 300, 300)
  assert.deepEqual(placeBeside(size, anchor, 'right', 0, [anchor, outer]), { x: 100, y: 40, adjusted: false })
  assert.deepEqual(placeBeside(size, anchor, 'right', 10, [anchor, box(110, 35, 20, 30)]), { x: 110, y: 80, adjusted: true })
  assert.deepEqual(placeBeside(size, anchor, 'right', 10, [anchor, box(110, -600, 20, 1200)]), { x: 150, y: 40, adjusted: true })
  assert.deepEqual(placeBeside(size, anchor, 'right', 10, [anchor, box(110, -600, 400, 1200)]), { x: 40, y: 200, adjusted: true })
  const elements: SceneElement[] = [existing[0], existing[1], { id: 'note', type: 'text', x: 440, y: 0, width: 100, height: 60, text: '占位' }]
  const plan = planOps([{ op: 'move', id: 'N1', near: 'N2' }], buildGraph(elements), ids())
  assert.equal(plan.moves[0].adjusted, true)
  assert.deepEqual(plan.moves[0].toBbox, box(440, 80, 100, 60))
})

test('move：精确落点报告最终碰撞，原包围框和已删除或已移开的元素不计入', () => {
  const elements: SceneElement[] = [
    ...existing,
    { id: 'frame', type: 'rectangle', x: -15, y: -15, width: 600, height: 140 },
    { id: 'note', type: 'text', x: 320, y: 5, width: 50, height: 25, text: '撞上' },
    { id: 'deleted', type: 'text', x: 330, y: 5, width: 20, height: 25, text: '要删' }
  ]
  const graph = buildGraph(elements)
  const nodeId = graph.nodes.find((n) => n.ref === 'rb')!.id
  const noteId = graph.notes.find((n) => n.ref === 'note')!.id
  const deleted = graph.notes.find((n) => n.ref === 'deleted')!.id
  const plan = planOps([{ op: 'move', id: 'ra', x: 300, y: 0 }, { op: 'delete_text', id: deleted }], graph, ids())
  assert.deepEqual(plan.moves[0].overlaps, [nodeId, noteId])
  const relative = planOps([{ op: 'move', id: 'ra', dx: 300 }, { op: 'move', id: 'rb', dx: 350 }], graph, ids())
  assert.deepEqual(relative.moves[0].overlaps, [noteId, deleted])
})

test('move 与新节点、显式宽度、新连线和旁注共用最终框体', () => {
  const plan = planOps([
    { op: 'move', id: 'N1', near: 'fresh', side: 'left', gap: 30 },
    { op: 'add_node', id: 'fresh' },
    { op: 'add_edge', from: 'N1', to: 'fresh' },
    { op: 'add_text', text: 'note', near: 'N1' },
    { op: 'set_style', id: 'N1', width: 200 },
    { op: 'update_node', id: 'N1', label: '一段会自动扩宽的中文文本'.repeat(4) },
    { op: 'set_style', id: 'N1', height: 60 }
  ], buildGraph([existing[0]]), ids())
  const [node] = plan.nodes
  const [move] = plan.moves
  assert.deepEqual(move.fromBbox, box(-50, 0, 200, 60))
  assert.deepEqual(move.toBbox, box(node.x - 230, node.y, 200, 60))
  assert.deepEqual([plan.edges[0].x, plan.edges[0].y], [node.x - 22, node.y + 30])
  assert.deepEqual([plan.texts[0].x, plan.texts[0].y], [move.toBbox.x + 76, node.y + 74])
})

test('update_node 的虚拟扩宽保留中心、封顶、只扩不缩，并供近置与旁注使用', () => {
  const graph = buildGraph([existing[0], { ...existing[1], width: 420 }])
  const plan = planOps([
    { op: 'move', id: 'N1', near: 'N2', gap: 0 },
    { op: 'update_node', id: 'N1', label: '架构'.repeat(25) },
    { op: 'update_node', id: 'N2', label: '旧指令中的大段文字'.repeat(20) },
    { op: 'update_node', id: 'N2', label: '短' },
    { op: 'add_text', text: '旁注', near: 'N1' }
  ], graph, ids())
  const [move] = plan.moves
  assert.equal(move.fromBbox.w, 360)
  assert.equal(move.fromBbox.x + move.fromBbox.w / 2, 50)
  assert.equal(move.fromBbox.y + move.fromBbox.h / 2, 30)
  assert.equal(move.toBbox.x, 720)
  assert.deepEqual(plan.updates.map(({ elementId, label }) => [elementId, label]), [['ra', '架构'.repeat(25)], ['rb', '短']])
  assert.equal(plan.texts[0].y, move.toBbox.y + move.toBbox.h + 14)
})

test('update_node 的虚拟高度使用 25px 行高和形状的 10px 内边距，显式高度优先', () => {
  for (const [type, expected] of [['rectangle', 85], ['ellipse', 120], ['diamond', 170]] as const) {
    const graph = buildGraph([{ ...existing[0], type, width: 240 }])
    const ops: DrawOp[] = [{ op: 'update_node', id: 'N1', label: 'A\nB\nC' }, { op: 'move', id: 'N1', x: 300, y: 200 }]
    const [move] = planOps(ops, graph, ids()).moves
    assert.deepEqual(move.fromBbox, box(0, 30 - expected / 2, 240, expected), type)
    assert.deepEqual(move.toTopLeft, { x: 300, y: 200 })
    const explicit = planOps([...ops, { op: 'set_style', id: 'N1', height: 45 }], graph, ids())
    assert.equal(explicit.moves[0].fromBbox.h, 45)
  }
  const [moved] = planOps([
    { op: 'update_node', id: 'N1', label: '短' }, { op: 'move', id: 'N1', dy: 20 }
  ], buildGraph([{ ...existing[0], height: 200 }]), ids()).moves
  assert.equal(moved.fromBbox.h, 200)
})

test('dagre 放新节点时释放本批移走或删除的旧框，trace_image 读取已移动的图片', () => {
  const placed = planOps([
    { op: 'add_node', id: 'fresh' },
    { op: 'move', id: 'N1', x: 1000, y: 1000 },
    { op: 'delete_node', id: 'N2' }
  ], buildGraph(existing), ids(), { view: box(0, 0, 500, 100) })
  assert.deepEqual([placed.nodes[0].x, placed.nodes[0].y], [0, 0])
  const graph = buildGraph([{ id: 'img', type: 'image', x: 100, y: 200, width: 100, height: 50, fileId: 'file' }])
  const traced = planOps([
    { op: 'move', id: 'I1', dx: 250 },
    { op: 'trace_image', image: 'I1', place: 'over', space: { w: 100, h: 50 }, elements: [{ kind: 'box', x: 5, y: 10, w: 30, h: 20 }] }
  ], graph, ids())
  assert.deepEqual([traced.nodes[0].x, traced.nodes[0].y], [355, 210])
})

test('rebaseOps 同时换算 move 目标与 near 锚点，保留新节点 key 与稳定 id', () => {
  const before = buildGraph(existing)
  const after = buildGraph([{ id: 'inserted', type: 'rectangle', x: -300, y: 0, width: 100, height: 60 }, ...existing])
  const result = rebaseOps([
    { op: 'move', id: ' N1 ', near: ' N2 ' },
    { op: 'move', id: ' rb ', near: ' fresh ' },
    { op: 'add_node', id: ' fresh ' }
  ], before.nodes, after)
  assert.deepEqual(result, { gone: [], ops: [
    { op: 'move', id: 'N2', near: 'N3' },
    { op: 'move', id: 'rb', near: 'fresh' },
    { op: 'add_node', id: ' fresh ' }
  ] })
  assert.deepEqual(rebaseOps([{ op: 'move', id: 'N1', near: 'N2' }], before.nodes, buildGraph([existing[0]])).gone, ['N2'])
})

test('rebaseOps 和 planOps 对带空白的旧短号仍指向原节点和 near 锚点', () => {
  const before = buildGraph(existing)
  const after = buildGraph([{ ...existing[0], id: 'inserted', x: -300 }, ...existing])
  const ops: DrawOp[] = [
    { op: 'move', id: ' N1 ', near: 'N2\n' },
    { op: 'update_node', id: 'N1\n', label: '改字' },
    { op: 'set_style', id: ' N1 ', color: '#123' },
    { op: 'add_text', text: '旁注', near: ' N2\n' }
  ]
  const rebased = rebaseOps(ops, before.nodes, after)
  assert.deepEqual(rebased.gone, [])
  for (const plan of [planOps(ops, before, ids()), planOps(rebased.ops, after, ids())]) {
    assert.deepEqual(plan.moves[0].elementIds, ['ra'])
    assert.deepEqual(plan.moves[0].toTopLeft, { x: 440, y: 0 })
    assert.equal(plan.updates[0].elementId, 'ra')
    assert.equal(plan.styles[0].elementId, 'ra')
    assert.equal(plan.texts[0].x + estimateTextWidth(plan.texts[0].text) / 2, 350)
  }
})

test('rebaseOps 仅重映射成员完整且仍为同一组的手绘短号', () => {
  const stroke = (id: string, x: number): SceneElement => ({ id, type: 'freedraw', x, y: 0, width: 20, height: 20, points: [[0, 0], [20, 20]] })
  const original = [stroke('f1', 30), stroke('f2', 35)]
  const before = buildGraph(original).strokeGroups[0]
  const base = [{ id: before.id, ref: before.refs[0], refs: before.refs }]
  const op: DrawOp = { op: 'move', id: ' S1 ', dx: 50 }
  const intact = buildGraph([stroke('new1', -400), stroke('new2', -392), ...original])
  assert.deepEqual(rebaseOps([op], base, intact), { gone: [], ops: [{ op: 'move', id: 'S2', dx: 50 }] })
  for (const after of [
    [original[0]],
    [original[0], stroke('f2', 500)],
    [...original, stroke('f3', 40)]
  ]) assert.deepEqual(rebaseOps([op], base, buildGraph(after)).gone, ['S1'])
})

test('rebaseOps 三笔手绘组少一笔时拒绝旧版 move 和 delete_strokes', () => {
  const original = ['f1', 'f2', 'f3'].map((id, i): SceneElement => ({
    id, type: 'freedraw', x: 30 + i * 5, y: 0, width: 20, height: 20, points: [[0, 0], [20, 20]]
  }))
  const [before] = buildGraph(original).strokeGroups
  assert.equal(before.id, 'S1')
  assert.deepEqual(before.refs, ['f1', 'f2', 'f3'])
  const base = [{ id: before.id, ref: before.refs[0], refs: before.refs }]
  const ops: DrawOp[] = [{ op: 'move', id: 'S1', dx: 50 }, { op: 'delete_strokes', id: 'S1' }]
  for (const removed of original) {
    const after = buildGraph(original.map((stroke) => stroke === removed ? { ...stroke, isDeleted: true } : stroke))
    assert.equal(after.strokeGroups[0].id, 'S1')
    assert.deepEqual(after.strokeGroups[0].refs, before.refs.filter((ref) => ref !== removed.id))
    for (const op of ops) {
      assert.deepEqual(rebaseOps([op], base, after).gone, ['S1'], `${op.op}: ${removed.id} deleted`)
    }
  }
})

test('toProposalPlan 用原位框批准移动及同目标的改字，落点框可单独否决移动', () => {
  const graph = buildGraph(existing)
  const info = { box: (ref: string) => graph.nodes.find((n) => n.ref === ref)?.bbox ?? null, name: () => '节点「登录」' }
  for (const edit of [false, true]) {
    const ops: DrawOp[] = [{ op: 'move', id: 'N1', x: -300, y: 150 }]
    if (edit) ops.push({ op: 'update_node', id: 'N1', label: '新标签' })
    const batch = planOps(ops, graph, ids())
    const { plan, pending } = toProposalPlan(batch, info, ids())
    assert.deepEqual(plan.moves, [])
    assert.equal(plan.reroutes, undefined)
    assert.deepEqual(plan.updates, [])
    assert.equal(plan.markers.length, 1)
    const [frame] = plan.markers
    assert.equal(frame.note, edit ? '改成「新标签」，移走' : '移走')
    assert.equal(frame.summary, edit ? '把节点「登录」改成「新标签」，移走' : '移动节点「登录」')
    assert.deepEqual([frame.x, frame.y, frame.w, frame.h], [-10, -10, 120, 80])
    const [ghost] = plan.moveGhosts!
    assert.equal(ghost.frameId, frame.frameId)
    assert.equal(ghost.summary, '移动节点「登录」')
    assert.equal(ghost.label, '「登录」移到这里')
    assert.deepEqual([ghost.x, ghost.y, ghost.w, ghost.h], [-300, 150, batch.moves[0].toBbox.w, batch.moves[0].toBbox.h])
    assert.deepEqual(pending?.moves, batch.moves)
    assert.deepEqual(pending?.moves?.[0].toTopLeft, { x: -300, y: 150 })
    assert.equal(pending?.updates.length, Number(edit))
    const { w: _w, h: _h, label: _label, ...compact } = ghost
    assert.deepEqual(pending?.moveGhosts, [compact])
  }
})

for (const [scenario, name, label] of [
  ['多行标签', '节点「写审计日志\n发刷新令牌\n推下游事件」', '「写审计日志…」移到这里'],
  ['超长单行标签', '节点「统一身份认证会话续期」', '「统一身份认证会话…」移到这里'],
  ['无标签', '节点 N1', 'N1 移到这里']
]) {
  test(`toProposalPlan 落点框提示：${scenario}`, () => {
    const batch = planOps([{ op: 'move', id: 'N1', dx: 100 }], buildGraph(existing), ids())
    const { plan, pending } = toProposalPlan(batch, { box: () => null, name: () => name }, ids())
    assert.equal(plan.moveGhosts?.[0]?.label, label)
    assert.equal(plan.moveGhosts?.[0]?.summary, `移动${name}`)
    assert.equal(pending?.moveGhosts?.[0]?.summary, `移动${name}`)
  })
}

test('reroutes：单端移动后用最终障碍重排，双端等量移动保留原折点', () => {
  const elements: (SceneElement & { elbowed?: boolean })[] = [
    existing[0],
    { ...existing[1], x: 500 },
    { id: 'middle', type: 'rectangle', x: 240, y: 10, width: 100, height: 48 },
    { id: 'bound', type: 'arrow', x: 100, y: 30, width: 400, height: 0, startBinding: { elementId: 'ra' }, endBinding: { elementId: 'rb' } },
    { id: 'backwards', type: 'arrow', x: 100, y: 30, width: 400, height: 0, startBinding: { elementId: 'ra' }, endBinding: { elementId: 'rb' }, startArrowhead: 'arrow' },
    { id: 'one-free', type: 'arrow', x: 100, y: 30, width: 400, height: 0, startBinding: { elementId: 'ra' } },
    { id: 'user-bends', type: 'arrow', x: 100, y: 30, width: 400, height: 60, points: [[0, 0], [160, 60], [400, 0]], startBinding: { elementId: 'ra' }, endBinding: { elementId: 'rb' } },
    { id: 'agent-bends', type: 'arrow', x: 100, y: 30, width: 400, height: 60, points: [[0, 0], [160, 60], [400, 0]], startBinding: { elementId: 'ra' }, endBinding: { elementId: 'rb' }, ...agent },
    { id: 'agent-elbow', type: 'arrow', x: 100, y: 30, width: 400, height: 60, points: [[0, 0], [0, 60], [400, 60], [400, 0]], startBinding: { elementId: 'ra' }, endBinding: { elementId: 'rb' }, elbowed: true, ...agent }
  ]
  const graph = buildGraph(elements)
  const single = planOps([{ op: 'move', id: 'ra', dx: 25 }], graph, ids(), { elements })
  assert.deepEqual(single.reroutes?.map(({ arrowId, fromElementId, toElementId }) => [arrowId, fromElementId, toElementId]), [
    ['bound', 'ra', 'rb'], ['backwards', 'ra', 'rb'], ['agent-bends', 'ra', 'rb']
  ])
  const [route, reversed] = single.reroutes!
  assert.deepEqual(route.points[0], [0, 0])
  assert.ok(route.points.length > 2, '围绕中间未移动的节点绕行')
  assert.ok(route.x < 300)
  assert.deepEqual(reversed.points, route.points, '箭头头尾按实际绑定排列')
  const prop = toProposalPlan(single, { box: (ref) => graph.nodes.find((n) => n.ref === ref)?.bbox ?? null, name: () => '节点' }, ids())
  assert.equal(prop.plan.reroutes, undefined)
  assert.deepEqual(prop.pending?.reroutes, single.reroutes)
  const both: DrawOp[] = [{ op: 'move', id: 'ra', dy: 40 }, { op: 'move', id: 'rb', dy: 40 }]
  assert.equal(planOps(both, graph, ids(), { elements }).reroutes, undefined)
  const resized = planOps([...both, { op: 'set_style', id: 'N1', width: 160 }], graph, ids(), { elements })
  assert.equal(resized.reroutes?.length, 3)
})

test('三次从同一椭圆扇出，六条箭头不穿过兄弟节点或新旧旁注', () => {
  const scene: SceneElement[] = []
  const newId = ids()
  const routes: ReturnType<typeof planOps>['edges'] = []
  function append(ops: DrawOp[]) {
    const plan = planOps(ops, buildGraph(scene), newId, { elements: scene })
    for (const n of plan.nodes) scene.push({ id: n.elementId, type: n.shape, x: n.x, y: n.y, width: n.w, height: n.h })
    for (const t of plan.texts) scene.push({ id: t.elementId, type: 'text', text: t.text, x: t.x, y: t.y, width: estimateTextWidth(t.text), height: 25 })
    for (const e of plan.edges) {
      routes.push(e)
      scene.push({ id: e.elementId, type: 'arrow', x: e.x, y: e.y, width: 0, height: 0, points: e.points,
        startBinding: { elementId: e.fromElementId }, endBinding: { elementId: e.toElementId }, endArrowhead: 'arrow' })
    }
  }
  append([{ op: 'add_node', id: 'root', shape: 'ellipse', label: '④ 主人首跑新包', x: 155, y: 169 },
    { op: 'add_text', near: 'root', text: '首跑之后的改进看板：四个席位接力，各画自己负责的一块' }])
  const rootRef = scene[0].id
  for (const [batch, labels] of [
    ['本轮服务未监听：等端口起来再判定', '记住审批：超时不超过已批上限即命中'],
    ['完工提醒：托盘红点 + 任务栏闪烁', '按项目预填启动命令和地址', '记住「先拟计划」开关'],
    ['已完成：AGENTS.md · test:fast · 验证脚本']
  ].entries()) {
    const root = buildGraph(scene).nodes.find(n => n.ref === rootRef)!
    const ops: DrawOp[] = labels.flatMap((label, i): DrawOp[] => [
      { op: 'add_node', id: 'branch' + i, label },
      { op: 'add_edge', from: root.id, to: 'branch' + i, label: ['Codex：内核与审批', 'Antigravity：体验', 'Cursor：杂活'][batch] }
    ])
    if (batch === 2) ops.push({ op: 'add_text', near: 'branch0', text: '暂缓：跨轮复用 dev server、多 worktree、拆大文件' })
    append(ops)
  }
  assert.equal(routes.length, 6)
  for (const edge of routes) {
    const [dx, dy] = edge.points.at(-1)!
    for (const [x, y] of edge.points.slice(1, -1)) {
      // 超过一个正常块间距（100px）的横向偏移，会把连线标签带出分支间的空隙。
      assert.ok(Math.abs(x * dy - y * dx) / Math.hypot(dx, dy) <= 100, '拐点偏离直线超过 100px')
    }
    for (const box of scene.filter(b => b.type !== 'arrow' && b.id !== edge.fromElementId && b.id !== edge.toElementId)) {
      for (let i = 1; i < edge.points.length; i++) {
        const [ax, ay] = edge.points[i - 1]
        const [bx, by] = edge.points[i]
        // 计算线段在两个坐标轴上进入框内的参数区间；区间交集非空即穿框。
        function interval(start: number, end: number, lo: number, hi: number) {
          if (start === end) return start > lo && start < hi ? [-Infinity, Infinity] : [Infinity, -Infinity]
          const t = (lo - start) / (end - start), u = (hi - start) / (end - start)
          return [Math.min(t, u), Math.max(t, u)]
        }
        const tx = interval(ax + edge.x, bx + edge.x, box.x, box.x + box.width)
        const ty = interval(ay + edge.y, by + edge.y, box.y, box.y + box.height)
        assert.ok(Math.max(0, tx[0], ty[0]) >= Math.min(1, tx[1], ty[1]), '箭头穿过 ' + box.id)
      }
    }
  }
})
