// M0 验证脚本：读取导出的画板 JSON，打印里面的结构，确认数据够语义层用。
// 用法：npm run inspect [-- 画板文件路径]
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.FLYINGDRAWS_HOME || join(homedir(), '.flyingdraws')
const file = process.argv[2] ?? join(home, 'boards', 'default.excalidraw')
const scene = JSON.parse(readFileSync(file, 'utf8'))
const elements = (scene.elements ?? []).filter((el) => !el.isDeleted)
const byId = new Map(elements.map((el) => [el.id, el]))

const SHAPES = new Set(['rectangle', 'ellipse', 'diamond'])

// 容器里的文字：文字元素用 containerId 指向它所在的框或箭头
const labelOf = new Map()
for (const el of elements) {
  if (el.type === 'text' && el.containerId) labelOf.set(el.containerId, el.text)
}

const name = (id) => {
  const el = byId.get(id)
  if (!el) return `(缺失 ${id})`
  const label = labelOf.get(id)
  return label ? `[${label}]` : `[${el.type}#${id.slice(0, 4)}]`
}

const counts = {}
for (const el of elements) counts[el.type] = (counts[el.type] ?? 0) + 1

console.log(`文件：${file}`)
console.log(`元素：${elements.length} 个（不含已删除）`, counts)

console.log('\n节点：')
for (const el of elements.filter((e) => SHAPES.has(e.type))) {
  console.log(`  ${name(el.id)}  ${el.type} @(${Math.round(el.x)}, ${Math.round(el.y)}) ${Math.round(el.width)}x${Math.round(el.height)}`)
}

console.log('\n连线：')
for (const el of elements.filter((e) => e.type === 'arrow')) {
  const from = el.startBinding ? name(el.startBinding.elementId) : '(空)'
  const to = el.endBinding ? name(el.endBinding.elementId) : '(空)'
  const label = labelOf.get(el.id)
  console.log(`  ${from} → ${to}${label ? `  标签："${label}"` : ''}`)
}

console.log('\n游离文字：')
for (const el of elements.filter((e) => e.type === 'text' && !e.containerId)) {
  console.log(`  "${el.text}" @(${Math.round(el.x)}, ${Math.round(el.y)})`)
}

const strokes = elements.filter((e) => e.type === 'freedraw')
console.log(`\n手绘笔画：${strokes.length} 条`)
for (const el of strokes) {
  console.log(`  ${el.points.length} 个点，范围 @(${Math.round(el.x)}, ${Math.round(el.y)}) ${Math.round(el.width)}x${Math.round(el.height)}`)
}
