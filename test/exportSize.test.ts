import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chooseAdaptiveExportSize,
  EXPORT_BASE_SIZE,
  EXPORT_MAX_SIZE,
  EXPORT_MIN_SIZE,
  EXPORT_PADDING,
  MAX_EXPORT_BYTES,
  MAX_EXPORT_PIXELS,
  measureScene,
  nextExportSizeForBytes,
  type ExportSizeElement
} from '../src/renderer/src/exportSize.ts'

test('measureScene：忽略已删除元素与 marker，正确处理负宽高并加上双倍 exportPadding', () => {
  const elements: ExportSizeElement[] = [
    { x: 100, y: 200, width: -80, height: -50, type: 'rectangle' }, // [20..100] x [150..200]
    { x: 400, y: 300, width: 120, height: 100, type: 'ellipse' }, // [400..520] x [300..400]
    { x: 0, y: 0, width: 5000, height: 5000, type: 'rectangle', isDeleted: true },
    {
      x: -2000,
      y: -2000,
      width: 4000,
      height: 4000,
      type: 'ellipse',
      customData: { flyingdraws: { role: 'marker' } }
    },
    { x: 50, y: 50, width: 100, height: 20, type: 'text', text: '   ', fontSize: 6 },
    { x: 50, y: 80, width: 100, height: 20, type: 'text', text: 'label', fontSize: 16 }
  ]

  const m = measureScene(elements)
  assert.equal(m.elementCount, 4)
  assert.equal(m.freedrawCount, 0)
  // x: 20..520 => 500 + 48 = 548; y: 150..400 (text at 50..100!) => 50..400 => 350 + 48 = 398
  assert.equal(m.width, 500 + EXPORT_PADDING * 2)
  assert.equal(m.height, 350 + EXPORT_PADDING * 2)
  assert.equal(m.maxDim, 548)
  assert.equal(m.minDim, 398)
  assert.equal(m.minFontSize, 16)
})

test('chooseAdaptiveExportSize：空画布或仅含已删除/marker 元素返回 1200', () => {
  assert.equal(chooseAdaptiveExportSize([]), EXPORT_MIN_SIZE)
  assert.equal(
    chooseAdaptiveExportSize([
      { x: 0, y: 0, width: 3000, height: 3000, isDeleted: true },
      { x: 0, y: 0, width: 3000, height: 3000, customData: { flyingdraws: { role: 'marker' } } }
    ]),
    EXPORT_MIN_SIZE
  )
})

test('chooseAdaptiveExportSize：小且稀疏的场景保持紧凑 1200，中等大场景用 1600 基准', () => {
  const smallSparse: ExportSizeElement[] = [
    { x: 0, y: 0, width: 800, height: 500, type: 'rectangle' },
    { x: 40, y: 40, width: 200, height: 30, type: 'text', text: 'Small Flow', fontSize: 20 }
  ]
  assert.equal(chooseAdaptiveExportSize(smallSparse), EXPORT_MIN_SIZE)

  // maxDim > 1400（不含 text 缩字问题）升到 1600 baseline
  const mediumScene: ExportSizeElement[] = [
    { x: 0, y: 0, width: 1800, height: 900, type: 'rectangle' },
    { x: 50, y: 50, width: 300, height: 40, type: 'text', text: 'Big Title', fontSize: 28 }
  ]
  assert.equal(chooseAdaptiveExportSize(mediumScene), EXPORT_BASE_SIZE)
})

test('chooseAdaptiveExportSize：大图内含小字号文本时放大导出尺寸保证最小 ~14px 可读', () => {
  // 宽图 3000 x 800（加 padding 3048 x 848），14px 文字需要 ~3048px 才不会被缩糊
  const wideSmallText: ExportSizeElement[] = [
    { x: 0, y: 0, width: 3000, height: 800, type: 'rectangle' },
    { x: 100, y: 100, width: 200, height: 24, type: 'text', text: 'detail node', fontSize: 14 }
  ]
  const size = chooseAdaptiveExportSize(wideSmallText)
  assert.equal(size, 3048)

  // 更小字体（10px）在宽图上最高到 3200
  const tinyTextWide: ExportSizeElement[] = [
    { x: 0, y: 0, width: 3600, height: 900, type: 'rectangle' },
    { x: 100, y: 100, width: 120, height: 18, type: 'text', text: 'tiny', fontSize: 10 }
  ]
  assert.equal(chooseAdaptiveExportSize(tinyTextWide), EXPORT_MAX_SIZE)

  // 已删除或空文本的小字号不触发放大
  const ignoredSmallText: ExportSizeElement[] = [
    { x: 0, y: 0, width: 2400, height: 900, type: 'rectangle' },
    { x: 10, y: 10, width: 50, height: 16, type: 'text', text: 'deleted', fontSize: 8, isDeleted: true },
    { x: 20, y: 20, width: 50, height: 16, type: 'text', text: '', fontSize: 8 }
  ]
  assert.equal(chooseAdaptiveExportSize(ignoredSmallText), EXPORT_BASE_SIZE)
})

test('chooseAdaptiveExportSize：像素预算限制超大 1:1 画布不炸到 10MP，同时允许宽/高图到达 3200', () => {
  // 超大 1:1 画布 + 小字，受 MAX_EXPORT_PIXELS (4.5MP) 约束 -> sqrt(4_500_000) = 2121
  const hugeSquare: ExportSizeElement[] = [
    { x: 0, y: 0, width: 3952, height: 3952, type: 'rectangle' }, // +48 => 4000 x 4000
    { x: 100, y: 100, width: 120, height: 16, type: 'text', text: 'note', fontSize: 10 }
  ]
  const squareSize = chooseAdaptiveExportSize(hugeSquare)
  assert.equal(squareSize, Math.floor(Math.sqrt(MAX_EXPORT_PIXELS)))
  assert.ok(squareSize >= EXPORT_MIN_SIZE)
  assert.ok(squareSize * squareSize <= MAX_EXPORT_PIXELS)

  // 超大宽图 4000 x 1000（aspect ~ 0.25）可在像素预算内达到满额 3200
  const hugeWide: ExportSizeElement[] = [
    { x: 0, y: 0, width: 3952, height: 952, type: 'rectangle' }, // +48 => 4000 x 1000
    { x: 100, y: 100, width: 120, height: 16, type: 'text', text: 'note', fontSize: 10 }
  ]
  assert.equal(chooseAdaptiveExportSize(hugeWide), EXPORT_MAX_SIZE)
})

test('chooseAdaptiveExportSize：密集手绘笔画或大量元素的大场景自动提档保持清晰', () => {
  const strokes: ExportSizeElement[] = Array.from({ length: 10 }, (_, i) => ({
    x: i * 260,
    y: 0,
    width: 200,
    height: 400,
    type: 'freedraw'
  }))
  // x 跨度 0..2540 (+48 = 2588), y 跨度 0..400 (+48 = 448)
  const freedrawSize = chooseAdaptiveExportSize(strokes)
  assert.equal(freedrawSize, 2588)

  // 大量普通图形（>= 40）在宽图下也会提档
  const manyBoxes: ExportSizeElement[] = Array.from({ length: 42 }, (_, i) => ({
    x: i * 70,
    y: 0,
    width: 50,
    height: 300,
    type: 'rectangle'
  }))
  // 41*70 + 50 + 48 = 2968
  assert.equal(chooseAdaptiveExportSize(manyBoxes), 2968)
})

test('nextExportSizeForBytes：字节预算内或已到底线返回 null，超出时阶梯降档且不低于 1200', () => {
  assert.equal(nextExportSizeForBytes(2400, MAX_EXPORT_BYTES, MAX_EXPORT_BYTES), null)
  assert.equal(nextExportSizeForBytes(2400, 400 * 1024, MAX_EXPORT_BYTES), null)
  assert.equal(nextExportSizeForBytes(EXPORT_MIN_SIZE, 2 * 1024 * 1024, MAX_EXPORT_BYTES), null)

  // 略超上限：按 ~0.72x 降档
  const slight = nextExportSizeForBytes(3200, MAX_EXPORT_BYTES + 40 * 1024, MAX_EXPORT_BYTES)
  assert.equal(slight, Math.floor(3200 * 0.72))

  // 严重超出：按面积比加速降档，仍 >= 1200
  const heavy = nextExportSizeForBytes(3200, 4 * MAX_EXPORT_BYTES, MAX_EXPORT_BYTES)
  assert.ok(heavy !== null)
  assert.ok(heavy >= EXPORT_MIN_SIZE && heavy < slight!)

  // 接近底线时夹紧到 1200，再调用返回 null
  const clamped = nextExportSizeForBytes(1400, 2 * MAX_EXPORT_BYTES, MAX_EXPORT_BYTES)
  assert.equal(clamped, EXPORT_MIN_SIZE)
  assert.equal(nextExportSizeForBytes(clamped!, 2 * MAX_EXPORT_BYTES, MAX_EXPORT_BYTES), null)
})
