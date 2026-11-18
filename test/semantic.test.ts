import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { bboxOf, buildGraph, canvasRectToImagePixels, summarize, type SceneElement } from '../src/main/semantic.ts'

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

// 一笔手绘：从 from 到 to 的直线，中间插几个点
function stroke(from: [number, number], to: [number, number]): SceneElement {
  const n = 8
  return {
    id: `f${++seq}`,
    type: 'freedraw',
    x: from[0],
    y: from[1],
    width: to[0] - from[0],
    height: to[1] - from[1],
    points: Array.from({ length: n + 1 }, (_, i) => [((to[0] - from[0]) * i) / n, ((to[1] - from[1]) * i) / n] as [number, number])
  }
}
// 模拟一个手写字：横、竖、撇、捺四笔，外加一个很小的点
function handwrittenChar(x: number, y: number): SceneElement[] {
  return [
    stroke([x, y + 20], [x + 60, y + 20]),
    stroke([x + 30, y], [x + 30, y + 70]),
    stroke([x + 28, y + 30], [x, y + 65]),
    stroke([x + 32, y + 30], [x + 60, y + 65]),
    stroke([x + 55, y + 5], [x + 57, y + 7])
  ]
}

test('挨得近的手绘笔画合成一组，小点也算进去，并建议附图', () => {
  const g = buildGraph([...handwrittenChar(1000, 100), ...handwrittenChar(1080, 100)])
  assert.equal(g.strokes.length, 0)
  assert.equal(g.strokeGroups.length, 1)
  assert.equal(g.strokeGroups[0].count, 10)
  assert.equal(g.needsImage, true)
  const s = summarize(g, { board: 't', version: 1 })
  assert.match(s, /10 笔手绘/)
  assert.match(s, /一组手写或涂鸦（10 笔），内容请看附图/)
  assert.doesNotMatch(s, /一条直线/)
})

test('离得远的手写分成两组，方位按节点或画面位置描述', () => {
  const a = rect(0, 0)
  const withNode = buildGraph([a, label(a, '登录'), ...handwrittenChar(300, -200), ...handwrittenChar(300, 600)])
  assert.equal(withNode.strokeGroups.length, 2)
  assert.deepEqual(withNode.strokeGroups[0].near, { id: 'N1', position: '右上方' })
  assert.match(summarize(withNode, { board: 't', version: 1 }), /一组手写或涂鸦（5 笔），在 N1「登录」 右上方/)

  const noNode = buildGraph([text(0, 500, '左下角的字'), ...handwrittenChar(900, 0)])
  assert.equal(noNode.strokeGroups[0].near, null)
  assert.equal(noNode.strokeGroups[0].region, '右上角')
  assert.match(summarize(noNode, { board: 't', version: 1 }), /在画面右上角/)
})

test('圈住节点的圈不会和圈里圈外的笔画并成一组', () => {
  const a = rect(100, 100)
  const loop: SceneElement = {
    id: 'f-loop',
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
  const g = buildGraph([a, label(a, '这里'), loop, ...handwrittenChar(230, 90)])
  assert.equal(g.strokes.length, 1)
  assert.deepEqual(g.strokes[0].encloses, ['N1'])
  assert.equal(g.strokeGroups.length, 1)
  assert.equal(g.strokeGroups[0].count, 5)
})

test('单独的误点仍然被忽略', () => {
  const g = buildGraph([stroke([0, 0], [1, 1]), stroke([3, 3], [4, 4])])
  assert.equal(g.strokes.length, 0)
  assert.equal(g.strokeGroups.length, 0)
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

test('游离文字和手绘按 T/S 编号，标记框被忽略，多 agent 署名区分自己与其他 agent', () => {
  const mine: SceneElement = {
    id: 'n_mine',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    customData: { flyingdraws: { author: 'agent', agent: 'claude-code', layer: 'final' } }
  }
  const other: SceneElement = {
    id: 'n_other',
    type: 'rectangle',
    x: 300,
    y: 0,
    width: 100,
    height: 60,
    customData: { flyingdraws: { author: 'agent', agent: 'codex', layer: 'final' } }
  }
  const marker: SceneElement = {
    id: 'mk_1',
    type: 'rectangle',
    x: -10,
    y: -10,
    width: 120,
    height: 80,
    customData: { flyingdraws: { author: 'agent', layer: 'proposal', role: 'marker' } }
  }
  const markerText: SceneElement = {
    id: 'mk_t',
    type: 'text',
    x: -10,
    y: -36,
    width: 40,
    height: 20,
    text: '删除',
    containerId: null,
    customData: { flyingdraws: { author: 'agent', layer: 'proposal', role: 'marker' } }
  }
  const noteEl = text(0, 90, '旁注')
  const g = buildGraph([mine, other, marker, markerText, noteEl, ...handwrittenChar(500, 0), stroke([800, 0], [900, 0])])
  assert.equal(g.nodes.length, 2, 'marker 矩形不进入节点列表')
  assert.equal(g.notes.length, 1, 'marker 说明文字不进入旁注列表')
  assert.equal(g.notes[0].id, 'T1')
  assert.equal(g.strokeGroups[0].id, 'S1')
  assert.equal(g.strokes[0].id, 'S2')

  const s = summarize(g, { board: 't', version: 1, viewer: 'claude-code' })
  assert.match(s, /N1 （无文字）矩形【agent 画的】/)
  assert.match(s, /N2 （无文字）矩形【其他 agent（codex）画的】/)
  assert.match(s, /T1 「旁注」/)
  assert.match(s, /S1 一组手写或涂鸦/)
  assert.match(s, /S2 一条直线/)
})

test('往左上方画的手绘圈按实际点坐标算外接框，并能识别圈住了一组手写字', () => {
  const words = handwrittenChar(200, 200)
  // 从圈的右下角 (290, 290) 往左上画一圈回到起点：points 全是负偏移，width/height 为正
  const reverseLoop: SceneElement = {
    id: 'f-rev-loop',
    type: 'freedraw',
    x: 290,
    y: 290,
    width: 120,
    height: 120,
    points: Array.from({ length: 40 }, (_, i) => {
      const t = (i / 39) * 2 * Math.PI
      return [-60 + 60 * Math.cos(t), -60 + 60 * Math.sin(t)] as [number, number]
    })
  }
  assert.deepEqual(
    [Math.round(bboxOf(reverseLoop).x), Math.round(bboxOf(reverseLoop).y), Math.round(bboxOf(reverseLoop).w), Math.round(bboxOf(reverseLoop).h)],
    [170, 170, 120, 120]
  )
  const g = buildGraph([...words, reverseLoop])
  assert.equal(g.strokeGroups.length, 1, '里面的 5 笔手写正常聚成一组 S1')
  assert.equal(g.strokes.length, 1, '外面的圈没有被吞进手写组，单独保留为 S2')
  assert.deepEqual(g.strokes[0].encloses, ['S1'])
  const textOut = summarize(g, { board: 't', version: 1 })
  assert.match(textOut, /S2 一个圈，圈住了 S1（一组手写，5 笔）/)
})

test('图片带原图尺寸与来源元数据，图上的圈选/框选/箭头批注换算为原图像素坐标', () => {
  // 原图 1600×900，在画布上缩放到 800×450 放在 (100, 100)
  const screenshot: SceneElement = {
    id: 'img_page',
    type: 'image',
    x: 100,
    y: 100,
    width: 800,
    height: 450,
    customData: {
      flyingdraws: {
        author: 'agent',
        agent: 'Fuxi',
        seat: true,
        layer: 'final',
        result: 'a'.repeat(64),
        imageMeta: {
          naturalWidth: 1600,
          naturalHeight: 900,
          url: 'http://127.0.0.1:5173/login',
          viewport: { w: 1600, h: 900 },
          round: 2
        }
      }
    }
  }
  // 用户在画布 (500..650, 120..170) 画了一个圈（对应原图 x=800..1100, y=40..140）并写了旁注
  const circleOnBtn: SceneElement = {
    id: 'loop_btn',
    type: 'freedraw',
    x: 500,
    y: 120,
    width: 150,
    height: 50,
    points: Array.from({ length: 37 }, (_, i) => {
      const t = (i / 36) * 2 * Math.PI
      return [75 + 75 * Math.cos(t), 25 + 25 * Math.sin(t)] as [number, number]
    })
  }
  const noteNearCircle = text(500, 180, '按钮改成主色')
  const pointerArrow = arrow([50, 325], [300, 325]) // 箭头尖落在 (300, 325) -> 原图 (400, 450)
  const g = buildGraph([screenshot, circleOnBtn, noteNearCircle, pointerArrow])
  assert.deepEqual(g.images[0].naturalSize, { w: 1600, h: 900 })
  const loopAnn = g.images[0].annotations.find((a) => a.kind === 'loop')
  assert.ok(loopAnn)
  assert.deepEqual(loopAnn!.pixelBbox, { x: 800, y: 40, w: 300, h: 100 })
  assert.equal(loopAnn!.note, '按钮改成主色')
  const arrowAnn = g.images[0].annotations.find((a) => a.kind === 'arrow')
  assert.ok(arrowAnn)
  assert.deepEqual(arrowAnn!.pixelPoint, { x: 400, y: 450 })

  const out = summarize(g, { board: 'b', version: 2, viewer: 'Fuxi' })
  assert.match(out, /原图 1600×900 px，来源 http:\/\/127\.0\.0\.1:5173\/login，视口 1600×900，第 2 轮结果/)
  assert.match(out, /原图像素区域 x=800, y=40, w=300, h=100，批注「按钮改成主色」/)
  assert.match(out, /箭头指向 原图像素点 \(400, 450\)/)

  // 裁剪 + 水平翻转下的原图像素换算
  assert.deepEqual(
    canvasRectToImagePixels({ x: 100, y: 100, w: 100, h: 50 }, { x: 100, y: 100, w: 400, h: 200 }, { x: 200, y: 100, w: 800, h: 400 }, [-1, 1]),
    { x: 800, y: 100, w: 200, h: 100 }
  )
})
