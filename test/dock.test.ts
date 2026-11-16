import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dockedRect, pickTarget, snapSide } from '../src/main/dockGeometry.ts'

const work = { x: 0, y: 0, w: 1920, h: 1040 }
const agent = { x: 0, y: 0, w: 1000, h: 1040 } // 贴在屏幕左边的 agent 窗口

test('snapSide：画布的边靠近目标窗口的边就算贴上了，离得远或上下错开太多不算', () => {
  assert.equal(snapSide({ x: 1010, y: 100, w: 600, h: 500 }, agent), 'right', '左边缘离目标右边缘 10px')
  assert.equal(snapSide({ x: 980, y: 100, w: 600, h: 500 }, agent), 'right', '稍微压进去一点也算')
  assert.equal(snapSide({ x: 1100, y: 100, w: 600, h: 500 }, agent), null, '离了 100px')
  assert.equal(snapSide({ x: 1010, y: 900, w: 600, h: 500 }, agent), null, '上下只重叠一点点')
  const onRight = { x: 900, y: 0, w: 1000, h: 1040 }
  assert.equal(snapSide({ x: 300, y: 50, w: 590, h: 600 }, onRight), 'left', '画布右边缘贴着目标左边缘')
})

test('dockedRect：和目标等高、顶边对齐，宽度占满那一侧剩下的空间', () => {
  assert.deepEqual(dockedRect(agent, 'right', work), { x: 1000, y: 0, w: 920, h: 1040 })
  const mid = { x: 700, y: 40, w: 800, h: 900 }
  assert.deepEqual(dockedRect(mid, 'left', work), { x: 0, y: 40, w: 700, h: 900 })
  assert.deepEqual(dockedRect(mid, 'right', work), { x: 1500, y: 40, w: 420, h: 900 })
})

test('dockedRect：那一侧剩下的空间太窄就不吸；用户调过的宽度保留，但不超过剩下的空间', () => {
  const maximized = { x: 0, y: 0, w: 1920, h: 1040 }
  assert.equal(dockedRect(maximized, 'right', work), null)
  assert.equal(dockedRect({ x: 0, y: 0, w: 1600, h: 1040 }, 'right', work), null, '只剩 320px')
  assert.deepEqual(dockedRect(agent, 'right', work, { width: 600 }), { x: 1000, y: 0, w: 600, h: 1040 })
  assert.equal(dockedRect(agent, 'right', work, { width: 5000 })?.w, 920)
  assert.deepEqual(dockedRect({ x: 900, y: 0, w: 1000, h: 1040 }, 'left', work, { width: 500 }), { x: 400, y: 0, w: 500, h: 1040 }, '贴左侧时靠着目标')
})

test('pickTarget：按叠放顺序取第一个贴得上的窗口，跳过贴不上或放不下的', () => {
  const own = { x: 1005, y: 60, w: 700, h: 600 }
  const far = { id: 'far', rect: { x: 0, y: 0, w: 400, h: 1040 } }
  const full = { id: 'full', rect: { x: -600, y: 0, w: 1600, h: 1040 } } // 右边缘也在 1000，同样贴得上，但叠放顺序排在后面
  const picked = pickTarget(own, [far, { id: 'agent', rect: agent }, full], () => work)
  assert.equal(picked?.target.id, 'agent')
  assert.equal(picked?.side, 'right')
  assert.deepEqual(picked?.rect, { x: 1000, y: 0, w: 920, h: 1040 })

  const tight = { id: 'tight', rect: { x: 0, y: 0, w: 1600, h: 1040 } }
  assert.equal(pickTarget({ x: 1605, y: 0, w: 300, h: 600 }, [tight], () => work), null, '贴得上但放不下')
})
