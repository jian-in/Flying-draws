// 托盘图标：一张淡黄纸片，墨线描边，中间一道笔迹——和应用的线稿风一致。
// 直接按像素画出来（不依赖图标文件，打包时不用额外带资源）。纯函数，不依赖 Electron。

const PAPER = [0xff, 0xdf, 0x70] // --fd-primary
const INK = [0x2b, 0x2a, 0x26] // --fd-ink
const ALERT = [0xe0, 0x31, 0x31] // 提议里删除标记用的红色
// 提醒红点：右上角，外面一圈纸色把它和墨线描边隔开
const DOT = { x: 0.76, y: 0.24, r: 0.2, ring: 0.06 }
const SAMPLES = 4 // 每个像素 4×4 采样做抗锯齿

// 笔迹：一道从左下往右上的弧线，坐标按图标边长归一化
const STROKE: [number, number][] = [[0.27, 0.7], [0.36, 0.55], [0.48, 0.47], [0.6, 0.42], [0.74, 0.3]]

function distanceToSegment(px: number, py: number, [ax, ay]: [number, number], [bx, by]: [number, number]): number {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** 采样点的颜色；null 是透明（圆角外）。坐标按边长归一化到 0..1。 */
function colorAt(x: number, y: number, size: number, alert: boolean): number[] | null {
  if (alert) {
    const d = Math.hypot(x - DOT.x, y - DOT.y)
    if (d <= DOT.r) return ALERT
    if (d <= DOT.r + Math.max(DOT.ring, 1 / size)) return PAPER
  }
  const inset = 0.5 / size
  const radius = 0.24
  const border = Math.max(1.2 / size, 0.07)
  // 圆角矩形：到内缩矩形的距离
  const qx = Math.max(Math.abs(x - 0.5) - (0.5 - inset - radius), 0)
  const qy = Math.max(Math.abs(y - 0.5) - (0.5 - inset - radius), 0)
  const outside = Math.hypot(qx, qy) - radius
  if (outside > 0) return null
  if (outside > -border) return INK
  const pen = Math.max(1.6 / size, 0.11) / 2
  for (let i = 1; i < STROKE.length; i++) {
    if (distanceToSegment(x, y, STROKE[i - 1], STROKE[i]) <= pen) return INK
  }
  return PAPER
}

/**
 * size×size 的 BGRA 像素（预乘 alpha），给 nativeImage.createFromBitmap / addRepresentation 用。
 * `alert` 时右上角加一个红点：Agent 在等你确认。系统通知被关掉时，这是唯一看得见的提醒。
 */
export function trayIconPixels(size: number, alert = false): Buffer {
  if (!Number.isInteger(size) || size < 8 || size > 256) throw new Error('托盘图标尺寸无效')
  const pixels = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, covered = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const color = colorAt((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size, size, alert)
          if (!color) continue
          r += color[0]; g += color[1]; b += color[2]; covered++
        }
      }
      const n = SAMPLES * SAMPLES
      const offset = (py * size + px) * 4
      pixels[offset] = Math.round(b / n)
      pixels[offset + 1] = Math.round(g / n)
      pixels[offset + 2] = Math.round(r / n)
      pixels[offset + 3] = Math.round((covered / n) * 255)
    }
  }
  return pixels
}
