// 使用已经安装的 Electron 与生产依赖，打出可直接启动的目录；不下载打包器或运行时。
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const binary = process.platform === 'win32' ? 'fuxi.exe' : 'fuxi'
if (!existsSync(join(root, 'out', 'main', 'index.js')) || !existsSync(join(root, 'resources', 'fuxi', binary))) {
  throw new Error('请先运行 npm run build:fuxi 和 npm run build')
}
if (process.platform !== 'win32') throw new Error('当前目录打包脚本支持 Windows；其他平台仍可运行 npm start')
const destination = join(root, 'dist', `Flying-draws-${process.platform}-${process.arch}`)
if (existsSync(destination)) throw new Error(`目标已存在，请先关闭并自行移走旧包：${destination}`)
const npm = process.env.npm_execpath
if (!npm) throw new Error('请通过 npm run package:desktop 运行此脚本')
const modulesRoot = join(root, 'node_modules')
// 渲染器已打入 out/renderer；运行时只保留主进程原生库和 MCP 桥接的真实依赖闭包。
const packages = new Set()
async function include(name, from, optional = false) {
  let current = from
  let found
  while (true) {
    const candidate = join(current, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) { found = candidate; break }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  if (!found) { if (optional) return; throw new Error(`缺少运行时依赖：${name}`) }
  if (packages.has(found)) return
  packages.add(found)
  const info = JSON.parse(await readFile(join(found, 'package.json'), 'utf8'))
  for (const dependency of Object.keys(info.dependencies || {})) await include(dependency, found, dependency in (info.optionalDependencies || {}))
  for (const dependency of Object.keys(info.optionalDependencies || {})) await include(dependency, found, true)
  for (const dependency of Object.keys(info.peerDependencies || {})) await include(dependency, found, info.peerDependenciesMeta?.[dependency]?.optional === true)
}
const builtins = new Set([...builtinModules, 'electron'])
const entryFiles = [join(root, 'out/main/index.js'), join(root, 'out/preload/index.js'), join(root, 'out/bridge/index.js')]
const entries = new Set()
for (const file of entryFiles) {
  const source = await readFile(file, 'utf8')
  for (const match of source.matchAll(/\brequire\(["']([^"']+)["']\)/g)) {
    const name = match[1]
    if (name.startsWith('.') || name.startsWith('node:') || builtins.has(name)) continue
    entries.add(name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0])
  }
}
for (const name of entries) await include(name, root)
for (const path of packages) {
  const rel = relative(modulesRoot, path)
  if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(join(path, 'package.json'))) throw new Error('生产依赖路径无法确认，停止打包')
}
await mkdir(destination, { recursive: true })
await cp(join(root, 'node_modules', 'electron', 'dist'), destination, { recursive: true })
await rename(join(destination, 'electron.exe'), join(destination, 'Flying draws.exe'))
const app = join(destination, 'resources', 'app')
await mkdir(app, { recursive: true })
for (const folder of ['main', 'preload', 'renderer', 'bridge']) {
  await cp(join(root, 'out', folder), join(app, 'out', folder), { recursive: true })
}
await cp(join(root, 'resources', 'fuxi'), join(destination, 'resources', 'fuxi'), { recursive: true })
const original = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
await writeFile(join(app, 'package.json'), JSON.stringify({ name: original.name, productName: 'Flying draws', version: original.version, main: 'out/main/index.js' }, null, 2))
for (const path of packages) {
  const rel = relative(modulesRoot, path)
  await cp(path, join(app, 'node_modules', rel), { recursive: true, filter: entry => !relative(path, entry).split(sep).includes('node_modules') })
}
console.log(`可运行应用：${join(destination, 'Flying draws.exe')}`)
