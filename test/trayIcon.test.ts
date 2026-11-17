import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trayIconPixels } from '../src/main/trayIcon.ts'

const pixel = (buffer: Buffer, size: number, x: number, y: number) => {
  const o = (y * size + x) * 4
  return { b: buffer[o], g: buffer[o + 1], r: buffer[o + 2], a: buffer[o + 3] }
}

test('托盘图标：圆角外透明，描边是墨色，纸面是应用主色', () => {
  for (const size of [16, 24, 32]) {
    const icon = trayIconPixels(size)
    assert.equal(icon.length, size * size * 4)
    assert.equal(pixel(icon, size, 0, 0).a, 0, `${size}px 左上角应透明`)
    assert.equal(pixel(icon, size, size - 1, size - 1).a, 0, `${size}px 右下角应透明`)
    const edge = pixel(icon, size, Math.floor(size / 2), 1)
    assert.ok(edge.a > 200 && edge.r < 120, `${size}px 上边应是墨线`)
    // 纸面：左上方远离笔迹的位置
    const paper = pixel(icon, size, Math.round(size * 0.3), Math.round(size * 0.3))
    assert.deepEqual([paper.r, paper.g, paper.b, paper.a], [0xff, 0xdf, 0x70, 255], `${size}px 纸面颜色`)
  }
  assert.throws(() => trayIconPixels(4), /尺寸无效/)
})
