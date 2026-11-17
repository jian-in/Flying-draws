import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sliderToStrokeWidth, strokeWidthToSlider } from '../src/renderer/src/strokeWidth.ts'

test('滑杆刻度换成像素：原来的细 / 粗 / 特粗落在 5 / 10 / 20，0 按发丝线算，超出范围夹住', () => {
  assert.equal(sliderToStrokeWidth(5), 1)
  assert.equal(sliderToStrokeWidth(10), 2)
  assert.equal(sliderToStrokeWidth(20), 4)
  assert.equal(sliderToStrokeWidth(100), 20)
  assert.equal(sliderToStrokeWidth(0), 0.1)
  assert.equal(sliderToStrokeWidth(1), 0.2)
  assert.equal(sliderToStrokeWidth(37), 7.4)
  assert.equal(sliderToStrokeWidth(-5), 0.1)
  assert.equal(sliderToStrokeWidth(250), 20)
  assert.equal(sliderToStrokeWidth(Number.NaN), 0.1)
})

test('像素换回滑杆刻度：来回一致，画板里已有的超粗线停在 100', () => {
  assert.equal(strokeWidthToSlider(1), 5)
  assert.equal(strokeWidthToSlider(2), 10)
  assert.equal(strokeWidthToSlider(4), 20)
  assert.equal(strokeWidthToSlider(50), 100)
  assert.equal(strokeWidthToSlider(0), 0)
  assert.equal(strokeWidthToSlider(Number.NaN), 0)
  for (let v = 0; v <= 100; v += 1) assert.equal(strokeWidthToSlider(sliderToStrokeWidth(v)), v)
})
