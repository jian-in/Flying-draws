// 从图片二进制头或 Data URL 解析原始像素宽高（纯函数，零外部依赖，支持 PNG / GIF / WebP / JPEG / SVG）。

export interface ImagePixelSize {
  w: number
  h: number
}

export function parseImageBytesSize(buf: Uint8Array): ImagePixelSize | null {
  if (buf.length < 10) return null

  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR chunk (width @ 16..20, height @ 20..24, big-endian)
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const w = view.getUint32(16, false)
    const h = view.getUint32(20, false)
    return w > 0 && h > 0 ? { w, h } : null
  }

  // GIF87a / GIF89a: width @ 6..8, height @ 8..10 (little-endian)
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    const w = buf[6] | (buf[7] << 8)
    const h = buf[8] | (buf[9] << 8)
    return w > 0 && h > 0 ? { w, h } : null
  }

  // RIFF....WEBP
  if (
    buf.length >= 25 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    const chunk = String.fromCharCode(buf[12], buf[13], buf[14], buf[15])
    if (chunk === 'VP8 ' && buf.length >= 30) {
      // Lossy WebP keyframe header starts at 20; 23..26 = 0x9d 0x01 0x2a
      if (buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
        const w = (buf[26] | (buf[27] << 8)) & 0x3fff
        const h = (buf[28] | (buf[29] << 8)) & 0x3fff
        return w > 0 && h > 0 ? { w, h } : null
      }
    } else if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
      // Lossless WebP: 14-bit (w - 1) and 14-bit (h - 1) packed in bytes 21..24
      const b0 = buf[21]
      const b1 = buf[22]
      const b2 = buf[23]
      const b3 = buf[24]
      const w = 1 + (b0 | ((b1 & 0x3f) << 8))
      const h = 1 + (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10))
      return w > 0 && h > 0 ? { w, h } : null
    } else if (chunk === 'VP8X' && buf.length >= 30) {
      // Extended WebP: 24-bit LE (w - 1) @ 24..26, (h - 1) @ 27..29
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
      return w > 0 && h > 0 ? { w, h } : null
    }
  }

  // JPEG: FF D8 ... scan segments until SOFn
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 4 < buf.length) {
      if (buf[i] !== 0xff) {
        i++
        continue
      }
      // Skip fill 0xFF bytes
      while (i < buf.length && buf[i] === 0xff) i++
      if (i >= buf.length) break
      const marker = buf[i++]
      // Standalone markers without length
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue
      if (i + 2 > buf.length) break
      const segLen = (buf[i] << 8) | buf[i + 1]
      if (segLen < 2) break
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      if (isSof) {
        if (i + 7 > buf.length) return null
        const h = (buf[i + 3] << 8) | buf[i + 4]
        const w = (buf[i + 5] << 8) | buf[i + 6]
        return w > 0 && h > 0 ? { w, h } : null
      }
      i += segLen
    }
  }

  return null
}

function parseSvgTextSize(svg: string): ImagePixelSize | null {
  const tagMatch = svg.match(/<svg\b[^>]*>/i)
  if (!tagMatch) return null
  const tag = tagMatch[0]
  const attrNum = (name: string): number | null => {
    const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9]+(?:\\.[0-9]+)?)(?:px)?\\s*["']`, 'i'))
    if (!m) return null
    const v = Number(m[1])
    return Number.isFinite(v) && v > 0 ? Math.round(v) : null
  }
  const w = attrNum('width')
  const h = attrNum('height')
  if (w && h) return { w, h }
  const vb = tag.match(/\bviewBox\s*=\s*["']\s*[-+0-9.]+\s+[-+0-9.]+\s+([0-9]+(?:\.[0-9]+)?)\s+([0-9]+(?:\.[0-9]+)?)\s*["']/i)
  if (vb) {
    const vw = Math.round(Number(vb[1]))
    const vh = Math.round(Number(vb[2]))
    if (vw > 0 && vh > 0) return { w: vw, h: vh }
  }
  return null
}

export function parseImageHeaderSize(dataUrl: string): ImagePixelSize | null {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const header = dataUrl.slice(0, comma).toLowerCase()
  const payload = dataUrl.slice(comma + 1)

  if (header.includes('image/svg+xml')) {
    try {
      const text = header.includes(';base64')
        ? Buffer.from(payload.slice(0, 8192), 'base64').toString('utf8')
        : decodeURIComponent(payload.slice(0, 8192))
      return parseSvgTextSize(text)
    } catch {
      return null
    }
  }

  if (!header.includes(';base64')) return null
  // PNG/GIF/WebP only need the first ~64 bytes; JPEG with EXIF APP1 may need up to 64 KiB
  const maxChars = header.includes('image/jpeg') || header.includes('image/jpg') ? 96_000 : 128
  let slice = payload.slice(0, maxChars).replace(/\s+/g, '')
  const rem = slice.length % 4
  if (rem) slice = slice.slice(0, slice.length - rem)
  if (!slice) return null
  try {
    return parseImageBytesSize(Buffer.from(slice, 'base64'))
  } catch {
    return null
  }
}
