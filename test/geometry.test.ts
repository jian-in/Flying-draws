import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTO_TEXT_MAX_W,
  containerHeightFor,
  containerWidthFor,
  exitPoint,
  polylineMidpoint
} from '../src/main/geometry.ts'

test('containerWidthFor 与 containerHeightFor 按形状内切留白系数计算', () => {
  assert.equal(AUTO_TEXT_MAX_W, 320)
  // 短文本保底最小宽 120
  assert.equal(containerWidthFor('rectangle', 20), 120)
  // 矩形 1x、椭圆 1.4x、菱形 2x
  assert.equal(containerWidthFor('rectangle', 200), 240)
  assert.equal(containerWidthFor('ellipse', 200), Math.ceil(240 * 1.4))
  assert.equal(containerWidthFor('diamond', 200), 480)

  assert.equal(containerHeightFor('rectangle', 25), 60)
  assert.equal(containerHeightFor('diamond', 10), 90)
  assert.equal(containerHeightFor('diamond', 40), 140)
})

test('polylineMidpoint 对偶数点和奇数点折线分别取中间段中点与中间顶点', () => {
  // 2 点直线：取中点
  assert.deepEqual(polylineMidpoint(100, 50, [[0, 0], [200, 40]]), [200, 70])
  // 3 点折线（奇数个点）：取正中间拐点
  assert.deepEqual(polylineMidpoint(10, 20, [[0, 0], [80, -30], [160, 0]]), [90, -10])
  // 4 点双拐点走廊（偶数个点）：取第 2、3 个点之间线段的中点
  assert.deepEqual(polylineMidpoint(0, 0, [[0, 0], [40, -60], [160, -60], [200, 0]]), [100, -60])
})

test('exitPoint 对矩形、椭圆、菱形计算带间距轮廓出口', () => {
  const rect = exitPoint({ x: 0, y: 0, w: 100, h: 60, shape: 'rectangle' }, 200, 30, 8)
  assert.deepEqual(rect, [108, 30])
  const diamond = exitPoint({ x: 0, y: 0, w: 100, h: 100, shape: 'diamond' }, 200, 50, 0)
  assert.deepEqual(diamond, [100, 50])
})
