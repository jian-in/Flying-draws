// 把 Excalidraw 自带的字体拷到渲染进程的 public 目录，让应用不依赖 CDN。
import { cpSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts')
const dest = join(root, 'src', 'renderer', 'public', 'fonts')

if (!existsSync(src)) {
  console.error(`[copy-fonts] 找不到 ${src}，请先运行 npm install`)
  process.exit(1)
}
cpSync(src, dest, { recursive: true })
console.log(`[copy-fonts] fonts -> ${dest}`)
