// npm run icons：用开发时那份 Electron 把 resources/icon 下的 SVG 渲染成各尺寸 PNG 和 icon.ico（生成结果提交进仓库）。
const { app, BrowserWindow } = require('electron')
const { readFile, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const root = resolve(__dirname, '..')
const dir = join(root, 'resources', 'icon')
process.env.FLYINGDRAWS_HOME = join(root, 'out', 'icon-renderer')
app.setPath('userData', process.env.FLYINGDRAWS_HOME)
app.disableHardwareAcceleration()

// 在 Chromium 里运行：给 SVG 写明像素尺寸，直接按目标网格光栅化，小尺寸不糊。
async function render(svg, size, alert) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('<svg ', '<svg width="' + size + '" height="' + size + '" '))
  await img.decode()
  ctx.drawImage(img, 0, 0)
  if (alert) {
    for (const [radius, color] of [[0.217, '#fffbe6'], [0.158, '#e03131']]) {
      ctx.beginPath()
      ctx.arc(size * 0.785, size * 0.215, size * radius, 0, 2 * Math.PI)
      ctx.fillStyle = color
      ctx.fill()
    }
  }
  return canvas.toDataURL('image/png').split(',')[1]
}

async function generate() {
  await app.whenReady()
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await win.loadURL('about:blank')
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const header = Buffer.alloc(6 + sizes.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  const parts = [header]
  let offset = header.length
  for (const [i, size] of sizes.entries()) {
    const svg = await readFile(join(dir, size <= 24 ? 'icon-small.svg' : 'icon.svg'), 'utf8')
    for (const alert of size <= 32 ? [false, true] : [false]) {
      const encoded = await win.webContents.executeJavaScript('(' + render.toString() + ')(' + JSON.stringify(svg) + ',' + size + ',' + alert + ')')
      const png = Buffer.from(encoded, 'base64')
      await writeFile(join(dir, (alert ? 'alert-' : 'icon-') + size + '.png'), png)
      if (alert) continue
      const entry = 6 + i * 16
      header[entry] = header[entry + 1] = size === 256 ? 0 : size
      header.writeUInt16LE(1, entry + 4)
      header.writeUInt16LE(32, entry + 6)
      header.writeUInt32LE(png.length, entry + 8)
      header.writeUInt32LE(offset, entry + 12)
      parts.push(png)
      offset += png.length
    }
  }
  await writeFile(join(dir, 'icon.ico'), Buffer.concat(parts))
}
generate().then(() => app.quit(), err => { console.error(err); app.exit(1) })
