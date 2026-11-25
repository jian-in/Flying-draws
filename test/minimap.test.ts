import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_WIDTH_DEFAULT,
  AGENT_WIDTH_MAX,
  AGENT_WIDTH_MIN,
  clampAgentWidth,
  computeMinimapTransform,
  fullViewportBox,
  minimapElementBox,
  minimapLinearPoints,
  minimapShapeOutline,
  minimapToWorld,
  scrollForWorldCenter,
  worldToMinimap
} from '../src/renderer/src/canvas/minimapGeometry.ts'

const near = (actual: number, expected: number, label: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}：期望 ${expected}，实际 ${actual}`)

test('旋转 90° 的长箭头：预览折线和外框都按画布方向，点端点能把主视口居中到端点', () => {
  // 水平 1000 长的箭头，绕点集外框中心 (500, 0) 顺时针转 90°，变成竖直的 (500,-500)→(500,500)
  const arrow = { type: 'arrow', x: 0, y: 0, width: 1000, height: 0, angle: Math.PI / 2, points: [[0, 0], [1000, 0]] as [number, number][] }
  const pts = minimapLinearPoints(arrow)!
  near(pts[0].x, 500, '起点 x')
  near(pts[0].y, -500, '起点 y')
  near(pts[1].x, 500, '终点 x')
  near(pts[1].y, 500, '终点 y')
  const box = minimapElementBox(arrow)
  near(box.x, 500, '外框 x')
  near(box.y, -500, '外框 y')
  near(box.h, 1000, '外框高')
  assert.ok(box.w <= 1, '竖直箭头的外框宽度不应该还是 1000')

  // 再放一个旋转 90° 的 400×100 矩形：外框变成 100×400
  const rect = { type: 'rectangle', x: 2000, y: 0, width: 400, height: 100, angle: Math.PI / 2 }
  const rectBox = minimapElementBox(rect)
  near(rectBox.x, 2150, '矩形外框 x')
  near(rectBox.y, -150, '矩形外框 y')
  near(rectBox.w, 100, '矩形外框宽')
  near(rectBox.h, 400, '矩形外框高')
  const corners = minimapShapeOutline(rect)
  near(corners[0].x, 2250, '矩形左上角转到右上')
  near(corners[0].y, -150, '矩形左上角转到右上 y')

  // 小地图范围包住旋转后的真实位置；点箭头终点在小地图上的位置，主视口中心正好落在终点
  const viewport = fullViewportBox({ scrollX: 0, scrollY: 0, width: 800, height: 600, zoom: { value: 1 } })!
  const t = computeMinimapTransform([arrow, rect], viewport, 216, 132, 10)
  assert.ok(t.world.y <= -500 && t.world.y + t.world.h >= 500, '范围要包住竖直箭头的两端')
  for (const zoom of [0.5, 1, 2.5]) {
    const tip = worldToMinimap(500, 500, t)
    const world = minimapToWorld(tip.x, tip.y, t)
    const appState = { width: 800, height: 600, zoom: { value: zoom } }
    const scroll = scrollForWorldCenter(world.x, world.y, appState)
    const view = fullViewportBox({ ...scroll, ...appState })!
    near(view.x + view.w / 2, 500, `缩放 ${zoom} 时视口中心 x`)
    near(view.y + view.h / 2, 500, `缩放 ${zoom} 时视口中心 y`)
  }
})

test('旋转的椭圆用精确外框，菱形用四个顶点，未旋转图元的外框保持原样', () => {
  const ellipse = { type: 'ellipse', x: 0, y: 0, width: 200, height: 100, angle: Math.PI / 2 }
  const eb = minimapElementBox(ellipse)
  near(eb.w, 100, '椭圆外框宽')
  near(eb.h, 200, '椭圆外框高')
  const diamond = { type: 'diamond', x: 0, y: 0, width: 200, height: 100, angle: Math.PI / 4 }
  const db = minimapElementBox(diamond)
  // 菱形顶点 (100,0)(200,50)(100,100)(0,50) 绕 (100,50) 转 45°
  const r = Math.SQRT1_2
  near(db.w, 2 * Math.max(50 * r + 0, 100 * r), '菱形外框宽')
  const plain = minimapElementBox({ type: 'rectangle', x: 10, y: 20, width: -30, height: 40 })
  assert.deepEqual(plain, { x: -20, y: 20, w: 30, h: 40 })
})

test('小地图坐标正反变换一致，同时包住元素与当前视口', () => {
  const elements = [
    { x: 0, y: 0, width: 400, height: 200 },
    { x: 1000, y: 800, width: 300, height: 150 },
    { x: 5000, y: 5000, width: 100, height: 100, isDeleted: true },
    { x: 6000, y: 6000, width: 100, height: 100, opacity: 0 }
  ]
  const viewport = fullViewportBox({ scrollX: -100, scrollY: -50, width: 800, height: 600, zoom: { value: 1 } })!
  assert.deepEqual(viewport, { x: 100, y: 50, w: 800, h: 600 })

  const t = computeMinimapTransform(elements, viewport, 210, 140, 10)
  assert.equal(t.hasElements, true)
  // 删除和透明隐藏元素不撑大全局预览范围
  assert.ok(t.world.x + t.world.w < 2000)

  const pt = worldToMinimap(650, 420, t)
  const back = minimapToWorld(pt.x, pt.y, t)
  assert.ok(Math.abs(back.x - 650) < 1e-6)
  assert.ok(Math.abs(back.y - 420) < 1e-6)
})

test('scrollForWorldCenter 在不同缩放倍率下都精确居中目标点', () => {
  const scroll1 = scrollForWorldCenter(500, 300, { width: 1000, height: 600, zoom: { value: 1 } })
  assert.deepEqual(scroll1, { scrollX: 0, scrollY: 0 })

  const scroll2 = scrollForWorldCenter(500, 300, { width: 1000, height: 600, zoom: { value: 2 } })
  assert.deepEqual(scroll2, { scrollX: -250, scrollY: -150 })
  const box = fullViewportBox({ ...scroll2, width: 1000, height: 600, zoom: { value: 2 } })!
  assert.equal(box.x + box.w / 2, 500)
  assert.equal(box.y + box.h / 2, 300)
})

test('侧边栏宽度限制遵循最小、最大和窗口比例上限', () => {
  assert.equal(clampAgentWidth(Number.NaN, 1440), AGENT_WIDTH_DEFAULT)
  assert.equal(clampAgentWidth(120, 1440), AGENT_WIDTH_MIN)
  assert.equal(clampAgentWidth(1200, 1440), AGENT_WIDTH_MAX)
  assert.equal(clampAgentWidth(700, 900), Math.round(900 * 0.65))
})
