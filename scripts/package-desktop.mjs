// 使用已经安装的 Electron 与生产依赖，打出可直接启动的目录；不下载打包器或运行时。
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { setExecutableIcon } from './executable-icon.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rawArgs = process.argv.slice(2)
const supportedFlags = new Set(['--without-fuxi', '--require-fuxi', '--keep-old'])
for (const arg of rawArgs) {
  if (!supportedFlags.has(arg)) throw new Error(`未知参数：${arg}（支持 --without-fuxi / --require-fuxi / --keep-old）`)
}
const keepOld = rawArgs.includes('--keep-old')
const withoutFuxi = rawArgs.includes('--without-fuxi')
const requireFuxi = rawArgs.includes('--require-fuxi')
if (withoutFuxi && requireFuxi) {
  throw new Error('--without-fuxi 与 --require-fuxi 不能同时指定')
}
const binary = process.platform === 'win32' ? 'fuxi.exe' : 'fuxi'
const hasAppBuild =
  existsSync(join(root, 'out', 'main', 'index.js')) &&
  existsSync(join(root, 'out', 'preload', 'index.js')) &&
  existsSync(join(root, 'out', 'renderer', 'index.html')) &&
  existsSync(join(root, 'out', 'bridge', 'index.js'))
const hasFuxi = existsSync(join(root, 'resources', 'fuxi', binary))
if (!hasAppBuild) {
  throw new Error(withoutFuxi ? '请先运行 npm run build' : '请先运行 npm run fetch:fuxi（或 npm run build:fuxi）和 npm run build')
}
if (!withoutFuxi && !hasFuxi) {
  throw new Error('请先运行 npm run fetch:fuxi（或 npm run build:fuxi）和 npm run build（若只需免 Fuxi 纯画布桌面包，请运行 npm run package:canvas）')
}
if (process.platform !== 'win32') throw new Error('当前目录打包脚本支持 Windows；其他平台仍可运行 npm start')
const destination = join(root, 'dist', `Flying-draws-${process.platform}-${process.arch}`)
// --keep-old：旧包最后按它的目录修改时间（本地时区）改名留着，不删
let kept = null
if (existsSync(destination)) {
  if (!keepOld) throw new Error(`目标已存在，请先关闭并自行移走旧包，或加 --keep-old 自动改名保留：${destination}`)
  const t = statSync(destination).mtime
  const pad = n => String(n).padStart(2, '0')
  kept = `${destination}-prev-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}`
  if (existsSync(kept)) throw new Error(`保留旧包的目录已存在，请先处理：${kept}`)
}
const npm = process.env.npm_execpath
if (!npm) throw new Error('请通过 npm run package:desktop 或 npm run package:canvas 运行此脚本')
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
// 先在同级临时目录打完整，最后再换到标准路径：中途失败不会留下半个包，也不会动旧包
const staging = `${destination}-staging-${process.pid}`
if (existsSync(staging)) throw new Error(`临时目录已存在，请先处理：${staging}`)
try {
  await mkdir(staging, { recursive: true })
  await cp(join(root, 'node_modules', 'electron', 'dist'), staging, { recursive: true })
  await rename(join(staging, 'electron.exe'), join(staging, 'Flying draws.exe'))
  await setExecutableIcon(join(staging, 'Flying draws.exe'), join(root, 'resources', 'icon', 'icon.ico'))
  if (existsSync(join(staging, 'LICENSE'))) {
    await rename(join(staging, 'LICENSE'), join(staging, 'LICENSE.electron.txt'))
  }
  for (const doc of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
    if (existsSync(join(root, doc))) await cp(join(root, doc), join(staging, doc))
  }
  const app = join(staging, 'resources', 'app')
  await mkdir(app, { recursive: true })
  await cp(join(root, 'resources', 'icon'), join(app, 'resources', 'icon'), { recursive: true })
  for (const folder of ['main', 'preload', 'renderer', 'bridge']) {
    await cp(join(root, 'out', folder), join(app, 'out', folder), { recursive: true })
  }
  if (!withoutFuxi) {
    await cp(join(root, 'resources', 'fuxi'), join(staging, 'resources', 'fuxi'), { recursive: true })
  }
  const original = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: original.name, productName: 'Flying draws', version: original.version, main: 'out/main/index.js' }, null, 2))
  for (const path of packages) {
    const rel = relative(modulesRoot, path)
    await cp(path, join(app, 'node_modules', rel), { recursive: true, filter: entry => !relative(path, entry).split(sep).includes('node_modules') })
  }
} catch (error) {
  await rm(staging, { recursive: true, force: true })
  throw error
}
const busy = error => ['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)
// 刚写完的目录可能还被杀毒软件扫描占着，改名失败时稍等重试几次
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to) }
    catch (error) {
      if (!busy(error) || attempt >= 9) throw error
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
}
if (kept) {
  try { await renameWithRetry(destination, kept) }
  catch (error) {
    await rm(staging, { recursive: true, force: true })
    if (busy(error)) throw new Error(`旧包还在使用中，没法改名：请从托盘退出 Flying draws 后重试（${destination}）`)
    throw error
  }
  console.log(`旧包已改名保留：${kept}`)
}
try { await renameWithRetry(staging, destination) }
catch (error) {
  if (kept) await rename(kept, destination).catch(() => {})
  throw new Error(`新包没能换到标准路径${kept ? '，旧包已尽量恢复原名' : ''}；新包留在：${staging}（${error.message}）`)
}
const modeLabel = withoutFuxi ? '（免 Fuxi 纯画布包）' : '（含内置 Fuxi 内核）'
console.log(`可运行应用${modeLabel}：${join(destination, 'Flying draws.exe')}`)
