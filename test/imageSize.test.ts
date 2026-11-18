import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseImageBytesSize, parseImageHeaderSize } from '../src/main/imageSize.ts'

test('parseImageHeaderSize 解析 PNG / GIF / WebP (VP8, VP8L, VP8X) / JPEG / SVG 的原始像素尺寸', () => {
  // 1. PNG (1280 x 720)
  const png = Buffer.alloc(32)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]).copy(png, 0)
  png.writeUInt32BE(1280, 16)
  png.writeUInt32BE(720, 20)
  assert.deepEqual(parseImageHeaderSize(`data:image/png;base64,${png.toString('base64')}`), { w: 1280, h: 720 })

  // 2. GIF89a (640 x 480)
  const gif = Buffer.alloc(16)
  gif.write('GIF89a', 0, 'ascii')
  gif.writeUInt16LE(640, 6)
  gif.writeUInt16LE(480, 8)
  assert.deepEqual(parseImageHeaderSize(`data:image/gif;base64,${gif.toString('base64')}`), { w: 640, h: 480 })

  // 3. WebP VP8X (1920 x 1080)
  const webpx = Buffer.alloc(32)
  webpx.write('RIFF', 0, 'ascii')
  webpx.write('WEBP', 8, 'ascii')
  webpx.write('VP8X', 12, 'ascii')
  const wMinus1 = 1919
  const hMinus1 = 1079
  webpx[24] = wMinus1 & 0xff
  webpx[25] = (wMinus1 >> 8) & 0xff
  webpx[26] = (wMinus1 >> 16) & 0xff
  webpx[27] = hMinus1 & 0xff
  webpx[28] = (hMinus1 >> 8) & 0xff
  webpx[29] = (hMinus1 >> 16) & 0xff
  assert.deepEqual(parseImageHeaderSize(`data:image/webp;base64,${webpx.toString('base64')}`), { w: 1920, h: 1080 })

  // 4. WebP VP8L (800 x 600)
  const webpl = Buffer.alloc(28)
  webpl.write('RIFF', 0, 'ascii')
  webpl.write('WEBP', 8, 'ascii')
  webpl.write('VP8L', 12, 'ascii')
  webpl[20] = 0x2f
  const packed = (800 - 1) | ((600 - 1) << 14)
  webpl.writeUInt32LE(packed >>> 0, 21)
  assert.deepEqual(parseImageBytesSize(webpl), { w: 800, h: 600 })

  // 5. JPEG with EXIF APP1 segment before SOF0 (1024 x 768)
  const jpeg = Buffer.alloc(40)
  jpeg[0] = 0xff
  jpeg[1] = 0xd8
  // APP1 segment of length 10
  jpeg[2] = 0xff
  jpeg[3] = 0xe1
  jpeg.writeUInt16BE(10, 4)
  // SOF0 marker at offset 14
  jpeg[14] = 0xff
  jpeg[15] = 0xc0
  jpeg.writeUInt16BE(17, 16)
  jpeg[18] = 8
  jpeg.writeUInt16BE(768, 19) // height
  jpeg.writeUInt16BE(1024, 21) // width
  assert.deepEqual(parseImageHeaderSize(`data:image/jpeg;base64,${jpeg.toString('base64')}`), { w: 1024, h: 768 })

  // 6. SVG with viewBox
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 900"><rect width="100" height="100"/></svg>`
  assert.deepEqual(parseImageHeaderSize(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`), { w: 1440, h: 900 })

  assert.equal(parseImageHeaderSize('not-a-data-url'), null)
})
