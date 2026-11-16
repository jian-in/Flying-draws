import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dockedRect, nearRect, pickTarget, sameRect, snapSide } from '../src/main/dockGeometry.ts'

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

test('dockedRect：保留 ownWidth 并夹在 [minW, avail]，手动 width 优先；未传宽度时兜底用 avail', () => {
  assert.deepEqual(dockedRect(agent, 'right', work, { ownWidth: 640 }), { x: 1000, y: 0, w: 640, h: 1040 })
  assert.deepEqual(dockedRect(agent, 'right', work, { ownWidth: 300 }), { x: 1000, y: 0, w: 420, h: 1040 }, 'ownWidth 小于 minW 时夹到 minW')
  assert.deepEqual(dockedRect(agent, 'right', work, { ownWidth: 1400 }), { x: 1000, y: 0, w: 920, h: 1040 }, 'ownWidth 大于 avail 时夹到 avail')
  assert.deepEqual(dockedRect(agent, 'right', work, { ownWidth: 640, width: 750 }), { x: 1000, y: 0, w: 750, h: 1040 }, '手动 width 优先于 ownWidth')
  assert.deepEqual(dockedRect(agent, 'right', work), { x: 1000, y: 0, w: 920, h: 1040 })

  const mid = { x: 700, y: 40, w: 800, h: 900 }
  assert.deepEqual(dockedRect(mid, 'left', work, { ownWidth: 500 }), { x: 200, y: 40, w: 500, h: 900 })
  assert.deepEqual(dockedRect(mid, 'right', work, { ownWidth: 600 }), { x: 1500, y: 40, w: 420, h: 900 })
})

test('dockedRect：垂直方向裁剪在 work 内，不遮挡任务栏也不越界；无可见高度或空间太窄返回 null', () => {
  const topTaskbarWork = { x: 0, y: 48, w: 1920, h: 992 } // 上方任务栏占 48px，底部到 1040
  assert.deepEqual(
    dockedRect({ x: 0, y: 0, w: 1000, h: 1080 }, 'right', topTaskbarWork, { ownWidth: 600 }),
    { x: 1000, y: 48, w: 600, h: 992 },
    '目标顶边和底边超出工作区时一并裁剪'
  )
  assert.deepEqual(
    dockedRect({ x: 0, y: 700, w: 1000, h: 500 }, 'right', work, { ownWidth: 600 }),
    { x: 1000, y: 700, w: 600, h: 340 },
    '仅底边超出任务栏时裁剪高度'
  )
  assert.deepEqual(
    dockedRect({ x: 0, y: -20, w: 1000, h: 600 }, 'right', work, { ownWidth: 600 }),
    { x: 1000, y: 0, w: 600, h: 580 },
    '仅顶边超出屏幕顶时裁剪 y 和 h'
  )
  assert.equal(dockedRect({ x: 0, y: 1040, w: 1000, h: 300 }, 'right', work, { ownWidth: 600 }), null, '完全在工作区下方')
  assert.equal(dockedRect({ x: 0, y: -400, w: 1000, h: 400 }, 'right', work, { ownWidth: 600 }), null, '完全在工作区上方')

  const maximized = { x: 0, y: 0, w: 1920, h: 1040 }
  assert.equal(dockedRect(maximized, 'right', work, { ownWidth: 600 }), null)
  assert.equal(dockedRect({ x: 0, y: 0, w: 1600, h: 1040 }, 'right', work, { ownWidth: 600 }), null, '只剩 320px')
})

test('pickTarget：按叠放顺序取第一个贴得上的窗口，保留画布宽度并支持 accept 过滤', () => {
  const own = { x: 1005, y: 60, w: 700, h: 600 }
  const far = { id: 'far', rect: { x: 0, y: 0, w: 400, h: 1040 } }
  const full = { id: 'full', rect: { x: -600, y: 0, w: 1600, h: 1040 } } // 右边缘也在 1000，同样贴得上，但叠放顺序排在后面
  const picked = pickTarget(own, [far, { id: 'agent', rect: agent }, full], () => work)
  assert.equal(picked?.target.id, 'agent')
  assert.equal(picked?.side, 'right')
  assert.deepEqual(picked?.rect, { x: 1000, y: 0, w: 700, h: 1040 })

  const skipped = pickTarget(own, [far, { id: 'agent', rect: agent }, full], () => work, {
    accept: (t, side) => !(t.id === 'agent' && side === 'right')
  })
  assert.equal(skipped?.target.id, 'full', '被抑制的目标跳过后可继续匹配后面的目标')

  const tight = { id: 'tight', rect: { x: 0, y: 0, w: 1600, h: 1040 } }
  assert.equal(pickTarget({ x: 1605, y: 0, w: 300, h: 600 }, [tight], () => work), null, '贴得上但放不下')
})

test('sameRect / nearRect：精确相等与像素容差判断', () => {
  const a = { x: 100, y: 200, w: 600, h: 800 }
  assert.equal(sameRect(a, { x: 100, y: 200, w: 600, h: 800 }), true)
  assert.equal(sameRect(a, { x: 101, y: 200, w: 600, h: 800 }), false)
  assert.equal(nearRect(a, { x: 102, y: 198, w: 601, h: 799 }, 2), true)
  assert.equal(nearRect(a, { x: 103, y: 200, w: 600, h: 800 }, 2), false)
  assert.equal(nearRect(a, null, 2), false)
})
