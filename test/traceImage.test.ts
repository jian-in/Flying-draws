import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, summarize, type SceneElement } from '../src/main/semantic.ts'
import { OpsError, planOps, rebaseOps, type DrawOp, type TraceImageOp } from '../src/main/ops.ts'

const ids = () => {
  let n = 0
  return () => `new${++n}`
}
// 画布上一张 400×200 的图，原图是 800×400 像素：图里的坐标缩小一半画到画布上
const photo: SceneElement[] = [{ id: 'img1', type: 'image', x: 100, y: 100, width: 400, height: 200 }]
const graph = buildGraph(photo)
const trace = (elements: TraceImageOp['elements'], extra: Partial<TraceImageOp> = {}): DrawOp => ({
  op: 'trace_image', image: 'I1', space: { w: 800, h: 400 }, elements, ...extra
})

test('读画布时图片有编号和位置，提示可以用 trace_image', () => {
  assert.equal(graph.images[0].id, 'I1')
  const text = summarize(graph, { board: 'b', version: 3 })
  assert.match(text, /trace_image/)
  assert.match(text, /I1 左上角 \(100, 100\)，画布上 400×200/)
})

test('照图还原：按 space 比例换算，画在原图右边，保留颜色、填充和字号', () => {
  const plan = planOps([trace([
    { kind: 'box', id: 'a', x: 0, y: 0, w: 200, h: 100, label: '登录', color: '#1971C2', fill: '#ffec99', font_size: 40 },
    { kind: 'text', x: 400, y: 300, text: '备注', color: '#e03131', font_size: 32 }
  ])], graph, ids())
  const [box] = plan.nodes
  const ox = box.x
  assert.ok(ox >= 100 + 400, '画在原图右边，不压原图')
  assert.equal(box.y, 100, '和原图顶端对齐')
  assert.deepEqual([box.w, box.h], [100, 50])
  assert.deepEqual([box.label, box.color, box.fill, box.fontSize, box.traced], ['登录', '#1971c2', '#ffec99', 20, true])
  const [note] = plan.texts
  assert.deepEqual([note.x - ox, note.y - 100, note.color, note.fontSize], [200, 150, '#e03131', 16])
  assert.deepEqual(plan.existingRefs, ['img1'], '执行前要确认原图还在')
  assert.deepEqual(plan.modifiedRefs, [], '原图本身不改')
})

test('照图还原：线条的箭头、虚线和绑定；from/to 可以指向排在后面的方框', () => {
  const plan = planOps([trace([
    { kind: 'line', points: [[200, 50], [400, 50]], arrow: 'end', dashed: true, from: 'a', to: 'b', color: '#2f9e44' },
    { kind: 'box', id: 'a', x: 0, y: 0, w: 200, h: 100 },
    { kind: 'box', id: 'b', x: 400, y: 0, w: 200, h: 100 },
    { kind: 'line', points: [[0, 200], [100, 250], [200, 200]] }
  ])], graph, ids())
  const [a, b] = plan.nodes
  const [arrow, plain] = plan.lines ?? []
  assert.deepEqual([arrow.fromElementId, arrow.toElementId], [a.elementId, b.elementId])
  assert.deepEqual([arrow.startArrow, arrow.endArrow, arrow.dashed, arrow.color], [false, true, true, '#2f9e44'])
  assert.deepEqual(arrow.points, [[0, 0], [100, 0]], '相对起点，按比例缩小')
  assert.equal(arrow.x, a.x + 100)
  assert.deepEqual([plain.startArrow, plain.endArrow, plain.fromElementId], [false, false, undefined])
  assert.deepEqual(plain.points, [[0, 0], [50, 25], [100, 0]])
})

test('照图还原：place over 叠在原图上，也能用稳定 id 指定图片', () => {
  const plan = planOps([trace([{ kind: 'box', x: 100, y: 40, w: 20, h: 20 }], { image: 'img1', place: 'over' })], graph, ids())
  assert.deepEqual([plan.nodes[0].x, plan.nodes[0].y], [150, 120])
  // 稳定 id 不随版本错位：不要求 base_version，但执行前仍要确认原图还在
  assert.deepEqual(plan.existingRefs, [])
  assert.deepEqual(plan.stableRefs, ['img1'])
})

test('照图还原：输入有问题时整批不画，说清楚哪里错', () => {
  const bad: [DrawOp, RegExp][] = [
    [trace([{ kind: 'box', x: 0, y: 0, w: 10, h: 10 }], { image: 'I9' }), /unknown image "I9"/],
    [{ op: 'trace_image', image: 'I1', elements: [{ kind: 'text', x: 0, y: 0, text: 'x' }] } as unknown as DrawOp, /space/],
    [trace([]), /1 to 500 elements/],
    [trace([{ kind: 'box', x: 0, y: 0, w: 10, h: 10, color: 'blue' }]), /hex/],
    [trace([{ kind: 'line', points: [[0, 0], [1, 1]], to: 'nope' }]), /no box with id "nope"/],
    [trace([{ kind: 'line', points: [[0, 0]] }]), /2 to 200 points/],
    [trace([{ kind: 'box', id: 'a', x: 0, y: 0, w: 1, h: 1 }, { kind: 'box', id: 'a', x: 0, y: 0, w: 1, h: 1 }]), /duplicate box id/],
    [trace([{ kind: 'circle', x: 0, y: 0 } as unknown as TraceImageOp['elements'][number]]), /"kind" must be/]
  ]
  for (const [op, message] of bad) assert.throws(() => planOps([op], graph, ids()), (e: unknown) => e instanceof OpsError && message.test(e.message))
})

test('图片编号随画板变化换算到同一张图', () => {
  const later = buildGraph([{ id: 'img0', type: 'image', x: 0, y: 0, width: 10, height: 10 }, ...photo])
  const { ops, gone } = rebaseOps([trace([{ kind: 'text', x: 0, y: 0, text: 'x' }])], [{ id: 'I1', ref: 'img1' }], later)
  assert.deepEqual(gone, [])
  assert.equal((ops[0] as TraceImageOp).image, 'I2', '前面多了一张图，原来的 I1 现在是 I2')
})
