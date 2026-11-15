// canvas_draw 的端到端测试：扮演 agent 调 MCP，在一块隔离的临时画板上画图再读回来。
//
// 用法（先 npm run build）：
//   node scripts/e2e-draw.mjs
//
// 用 SKETCHLINK_HOME 把画板和连接信息都指到 out/e2e-home，
// 不会碰用户的 ~/.sketchlink，也不用先关掉用户开着的画布。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdk = (p) => pathToFileURL(join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm', p)).href
const { Client } = await import(sdk('client/index.js'))
const { StdioClientTransport } = await import(sdk('client/stdio.js'))

const HOME = join(ROOT, 'out', 'e2e-home')
const OUT = join(ROOT, 'out', 'e2e')
rmSync(HOME, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })
mkdirSync(OUT, { recursive: true })

let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? '✔' : '✖'} ${label}`)
  if (!ok) failures += 1
}

const client = new Client({ name: 'sketchlink-e2e-draw', version: '0.0.1' })
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'out/bridge/index.js')],
    env: { ...process.env, SKETCHLINK_HOME: HOME },
    stderr: 'inherit'
  })
)
const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
const textOf = (res) => res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')

try {
  const tools = (await client.listTools()).tools.map((t) => t.name)
  check(tools.includes('canvas_draw'), '工具列表里有 canvas_draw')

  const first = textOf(await call('canvas_read', { image: 'never' }))
  check(/画板是空的/.test(first), '隔离的画板一开始是空的')

  // 在空画板上画一个三步流程
  const drawn = await call('canvas_draw', {
    ops: [
      { op: 'add_node', id: 'open', label: '打开 App' },
      { op: 'add_node', id: 'ask', label: '已登录？', shape: 'diamond' },
      { op: 'add_node', id: 'home', label: '首页' },
      { op: 'add_edge', from: 'open', to: 'ask' },
      { op: 'add_edge', from: 'ask', to: 'home', label: '是' },
      { op: 'add_text', text: '没登录就去登录页', near: 'ask' }
    ]
  })
  const drawnText = textOf(drawn)
  console.log(drawnText)
  check(!drawn.isError && /Drawn: 3 node\(s\), 2 arrow\(s\), 1 text\(s\)/.test(drawnText), 'canvas_draw 画出 3 个节点、2 条连线、1 段文字')
  check(/open = N1, ask = N2, home = N3/.test(drawnText), '返回新节点的编号')
  check(/N1「打开 App」 → N2「已登录？」【agent 画的】/.test(drawnText), '连线两端绑定到了节点上')
  check(/N2「已登录？」 → N3「首页」，标着「是」/.test(drawnText), '连线上的文字读得回来')
  check(/N2 「已登录？」菱形【agent 画的】/.test(drawnText), '节点标明是 agent 画的')
  const ver = Number(drawnText.match(/now at version (\d+)/)?.[1])
  check(ver > 0, `版本号 v${ver}`)

  // 连到已有节点：不带版本号要被拒绝
  const stale = await call('canvas_draw', {
    ops: [
      { op: 'add_node', id: 'login', label: '登录页' },
      { op: 'add_edge', from: 'N2', to: 'login', label: '否' }
    ]
  })
  check(stale.isError && /Nothing was drawn: the canvas changed/.test(textOf(stale)), '引用已有节点但没带 base_version：整批拒绝')
  const afterStale = textOf(await call('canvas_read', { image: 'never' }))
  check(!/「登录页」/.test(afterStale) && new RegExp(`v${ver}：3 个节点`).test(afterStale), '被拒绝的那批一个元素都没画上去')

  const linked = await call('canvas_draw', {
    base_version: ver,
    ops: [
      { op: 'add_node', id: 'login', label: '登录页' },
      { op: 'add_edge', from: 'N2', to: 'login', label: '否' }
    ]
  })
  const linkedText = textOf(linked)
  check(!linked.isError && /N2「已登录？」 → N4「登录页」，标着「否」/.test(linkedText), '带上 base_version 后能连到已有节点')
  check(new RegExp(`now at version ${ver + 1}\\b`).test(linkedText), '一批指令只升一次版本号')

  const bad = await call('canvas_draw', { ops: [{ op: 'add_edge', from: 'nope', to: 'N1' }], base_version: ver + 1 })
  check(bad.isError && /unknown node "nope"/.test(textOf(bad)), '引用不存在的节点：报错并说明原因')

  // 落盘的文件里有作者标记，别的 Excalidraw 也能打开
  const saved = JSON.parse(readFileSync(join(HOME, 'boards', 'default.excalidraw'), 'utf8'))
  const mine = saved.elements.filter((el) => el.customData?.sketchlink?.author === 'agent' && !el.isDeleted)
  check(saved.type === 'excalidraw' && mine.length === saved.elements.filter((el) => !el.isDeleted).length, `画板文件里 ${mine.length} 个元素都标了 agent`)
  const arrow = saved.elements.find((el) => el.type === 'arrow')
  const target = saved.elements.find((el) => el.id === arrow.endBinding?.elementId)
  check(Boolean(target?.boundElements?.some((b) => b.id === arrow.id)), '箭头和节点互相记录了绑定关系')

  const shot = await call('canvas_read', { image: 'always' })
  const img = shot.content.find((c) => c.type === 'image')
  check(Boolean(img), '截图')
  if (img) writeFileSync(join(OUT, 'draw.png'), Buffer.from(img.data, 'base64'))
} finally {
  await client.close()
  // 关掉测试开的那个画布实例
  try {
    process.kill(JSON.parse(readFileSync(join(HOME, 'daemon.json'), 'utf8')).pid)
  } catch {}
}
console.log(`\n${failures ? `✖ ${failures} 项失败` : '✔ 全部通过'}，截图在 ${join(OUT, 'draw.png')}`)
process.exit(failures ? 1 : 0)
