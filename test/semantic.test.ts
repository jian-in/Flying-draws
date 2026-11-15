import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildGraph, summarize, type SceneElement } from '../src/main/semantic.ts'

const fixture = (name: string): SceneElement[] =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')).elements

let seq = 0
function rect(x: number, y: number, w = 100, h = 60, extra: Partial<SceneElement> = {}): SceneElement {
  return { id: `r${++seq}`, type: 'rectangle', x, y, width: w, height: h, ...extra }
}
function label(container: SceneElement, text: string): SceneElement {
  return { id: `t${++seq}`, type: 'text', x: container.x + 10, y: container.y + 10, width: 50, height: 20, text, containerId: container.id }
}
function text(x: number, y: number, t: string): SceneElement {
  return { id: `t${++seq}`, type: 'text', x, y, width: 80, height: 20, text: t, containerId: null }
}
function arrow(from: [number, number], to: [number, number], extra: Partial<SceneElement> = {}): SceneElement {
  return {
    id: `a${++seq}`,
    type: 'arrow',
    x: from[0],
    y: from[1],
    width: to[0] - from[0],
    height: to[1] - from[1],
    points: [
      [0, 0],
      [to[0] - from[0], to[1] - from[1]]
    ],
    startArrowhead: null,
    endArrowhead: 'arrow',
    ...extra
  }
}

test('M0 手绘测试图：节点、连线、旁注、圈都能认出来', () => {
  const g = buildGraph(fixture('flow.excalidraw'))
  assert.deepEqual(
    g.nodes.map((n) => n.label),
    ['打开App', '登录页']
  )
  assert.equal(g.edges.length, 1)
  assert.deepEqual([g.edges[0].from, g.edges[0].to, g.edges[0].inferred], ['N1', 'N2', false])
  assert.equal(g.notes.length, 1)
  assert.equal(g.notes[0].text, '失败时重试')
  assert.equal(g.notes[0].attachedTo?.kind, 'edge')
  assert.equal(g.strokes[0].shape, 'loop')
  assert.equal(g.needsImage, false)

  const s = summarize(g, { board: 'test', version: 3 })
  assert.match(s, /N1「打开App」 → N2「登录页」/)
  assert.match(s, /「失败时重试」（在连线 N1→N2 的下方）/)
})

test('箭头只在起点有箭头时，方向反过来', () => {
  const a = rect(0, 0)
  const b = rect(300, 0)
  const ar = arrow([110, 30], [290, 30], { startBinding: { elementId: a.id }, endBinding: { elementId: b.id }, startArrowhead: 'arrow', endArrowhead: null })
  const g = buildGraph([a, label(a, 'A'), b, label(b, 'B'), ar])
  assert.deepEqual([g.edges[0].from, g.edges[0].to], ['N2', 'N1'])
})

test('没吸附的箭头按距离推测端点', () => {
  const a = rect(0, 0)
  const b = rect(300, 0)
  const g = buildGraph([a, b, arrow([120, 30], [285, 30])])
  assert.deepEqual([g.edges[0].from, g.edges[0].to, g.edges[0].inferred], ['N1', 'N2', true])
})

test('大框套小框识别为包含关系', () => {
  const outer = rect(0, 0, 400, 300)
  const inner = rect(50, 50)
  const g = buildGraph([outer, label(outer, '后端'), inner, label(inner, '数据库')])
  assert.deepEqual(g.containment, [{ parent: 'N1', child: 'N2' }])
  assert.match(summarize(g, { board: 't', version: 1 }), /N2 「数据库」矩形，在 N1「后端」 里面/)
})

test('圈住节点的手绘圈会报告圈住了谁', () => {
  const a = rect(100, 100)
  const loop: SceneElement = {
    id: 'f1',
    type: 'freedraw',
    x: 80,
    y: 80,
    width: 140,
    height: 100,
    points: Array.from({ length: 40 }, (_, i) => {
      const t = (i / 39) * 2 * Math.PI
      return [70 + 70 * Math.cos(t), 50 + 50 * Math.sin(t)] as [number, number]
    })
  }
  const g = buildGraph([a, label(a, '这里'), loop])
  assert.equal(g.strokes[0].shape, 'loop')
  assert.deepEqual(g.strokes[0].encloses, ['N1'])
})

test('游离文字挂到最近的节点上', () => {
  const a = rect(0, 0)
  const g = buildGraph([a, label(a, '登录'), text(0, 90, '要支持扫码'), text(2000, 2000, '远处的字')])
  assert.deepEqual(g.notes[0].attachedTo, { kind: 'node', id: 'N1' })
  assert.equal(g.notes[0].position, '下方')
  assert.equal(g.notes[1].attachedTo, null)
})

test('已删除的元素被忽略，空画板有提示', () => {
  const g = buildGraph([rect(0, 0, 100, 60, { isDeleted: true })])
  assert.equal(g.nodes.length, 0)
  assert.match(summarize(g, { board: 't', version: 1 }), /画板是空的/)
})

test('有曲线涂鸦时建议附图', () => {
  const squiggle: SceneElement = {
    id: 'f2',
    type: 'freedraw',
    x: 0,
    y: 0,
    width: 200,
    height: 60,
    points: Array.from({ length: 20 }, (_, i) => [i * 10, (i % 2) * 60] as [number, number])
  }
  const g = buildGraph([squiggle])
  assert.equal(g.strokes[0].shape, 'curve')
  assert.equal(g.needsImage, true)
})
