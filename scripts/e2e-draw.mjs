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

const DEBUG_PORT = 9334 // 隔离实例的 DevTools 端口，用来扮演用户点按钮
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 连上画布窗口，返回几个扮演用户的动作
async function connectPage() {
  let page
  for (let i = 0; i < 40 && !page; i++) {
    try {
      page = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()).find((t) => t.type === 'page')
    } catch {}
    if (!page) await sleep(500)
  }
  if (!page) throw new Error('找不到画布窗口')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let cid = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  })
  const cdp = (method, params = {}) =>
    new Promise((res) => {
      const i = ++cid
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const js = async (e) => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value
  const waitFor = async (fn, ms = 10000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const v = await fn()
      if (v) return v
      await sleep(200)
    }
    return null
  }
  return {
    bannerText: () => js(`document.querySelector('.sl-banner')?.innerText ?? null`),
    waitForBanner: () => waitFor(() => js(`document.querySelector('.sl-banner')?.innerText ?? null`)),
    waitForNoBanner: () => waitFor(() => js(`!document.querySelector('.sl-banner')`)),
    click: (label) =>
      js(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}); if(!b) return false; b.click(); return true })()`),
    typeNote: async (t) => {
      await js(`document.querySelector('.sl-banner-note')?.focus()`)
      await cdp('Input.insertText', { text: t })
    },
    screenshot: async (file) => writeFileSync(file, Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')),
    close: () => ws.close()
  }
}

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
    env: { ...process.env, SKETCHLINK_HOME: HOME, SKETCHLINK_DEBUG_PORT: String(DEBUG_PORT) },
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
  // 编号按阅读顺序排，不假设谁是 N1，用返回的对照表
  const idOf = (key, t = drawnText) => t.match(new RegExp(`\\b${key} = (N\\d+)`))?.[1]
  const [nOpen, nAsk, nHome] = ['open', 'ask', 'home'].map((k) => idOf(k))
  check(Boolean(nOpen && nAsk && nHome), `返回新节点的编号：open=${nOpen} ask=${nAsk} home=${nHome}`)
  check(drawnText.includes(`${nOpen}「打开 App」 → ${nAsk}「已登录？」【agent 画的】`), '连线两端绑定到了节点上')
  check(drawnText.includes(`${nAsk}「已登录？」 → ${nHome}「首页」，标着「是」`), '连线上的文字读得回来')
  check(drawnText.includes(`${nAsk} 「已登录？」菱形【agent 画的】`), '节点标明是 agent 画的')
  const ver = Number(drawnText.match(/now at version (\d+)/)?.[1])
  check(ver > 0, `版本号 v${ver}`)

  // 连到已有节点：不带版本号要被拒绝
  const stale = await call('canvas_draw', {
    ops: [
      { op: 'add_node', id: 'login', label: '登录页' },
      { op: 'add_edge', from: nAsk, to: 'login', label: '否' }
    ]
  })
  check(stale.isError && /Nothing was drawn: the canvas changed/.test(textOf(stale)), '引用已有节点但没带 base_version：整批拒绝')
  const afterStale = textOf(await call('canvas_read', { image: 'never' }))
  check(!/「登录页」/.test(afterStale) && new RegExp(`v${ver}：3 个节点`).test(afterStale), '被拒绝的那批一个元素都没画上去')

  const linked = await call('canvas_draw', {
    base_version: ver,
    ops: [
      { op: 'add_node', id: 'login', label: '登录页' },
      { op: 'add_edge', from: nAsk, to: 'login', label: '否' }
    ]
  })
  const linkedText = textOf(linked)
  check(!linked.isError && /「已登录？」 → N\d「登录页」，标着「否」/.test(linkedText), '带上 base_version 后能连到已有节点')
  check(new RegExp(`now at version ${ver + 1}\\b`).test(linkedText), '一批指令只升一次版本号')

  // 再画一块从上往下的，带一条跨层的连线，看排版和拐弯
  const down = await call('canvas_draw', {
    direction: 'down',
    ops: [
      { op: 'add_node', id: 'req', label: '收到请求', shape: 'ellipse' },
      { op: 'add_node', id: 'auth', label: '校验 token' },
      { op: 'add_node', id: 'db', label: '查数据库' },
      { op: 'add_node', id: 'resp', label: '返回结果', shape: 'ellipse' },
      { op: 'add_edge', from: 'req', to: 'auth' },
      { op: 'add_edge', from: 'auth', to: 'db', label: '通过' },
      { op: 'add_edge', from: 'db', to: 'resp' },
      { op: 'add_edge', from: 'auth', to: 'resp', label: '401' },
      { op: 'add_text', text: 'token 过期也算不通过', near: 'auth' }
    ]
  })
  check(!down.isError && /Drawn: 4 node\(s\), 4 arrow\(s\), 1 text\(s\)/.test(textOf(down)), 'direction: down 画出第二块流程')
  check(/「校验 token」 → N\d「返回结果」，标着「401」/.test(textOf(down)), '跨层的连线读得回来')

  const bad = await call('canvas_draw', { ops: [{ op: 'add_edge', from: 'nope', to: 'N1' }], base_version: ver + 2 })
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

  // ---------- 提议层：agent 画出理解，用户确认 ----------
  const user = await connectPage()
  const proposalOps = [
    { op: 'add_node', id: 'cache', label: '查缓存', shape: 'diamond' },
    { op: 'add_node', id: 'hit', label: '直接返回' },
    { op: 'add_edge', from: 'cache', to: 'hit', label: '命中' }
  ]
  const countOnDisk = () => JSON.parse(readFileSync(join(HOME, 'boards', 'default.excalidraw'), 'utf8')).elements.filter((el) => !el.isDeleted).length
  const before = countOnDisk()

  // 第一次：用户拒绝
  const p1 = textOf(await call('canvas_propose', { ops: proposalOps, question: '（自动测试）加一层缓存，是这个意思吗？' }))
  const req1 = p1.match(/req_\w+/)?.[0]
  check(Boolean(req1) && /「查缓存」菱形【agent 的提议，用户还没确认】/.test(p1), `canvas_propose 返回 ${req1}，读出来标着"提议"`)
  check(/加一层缓存，是这个意思吗/.test((await user.waitForBanner()) ?? ''), '画布上出现确认横幅')
  await sleep(600) // 等视野移到提议上再截图
  await user.screenshot(join(OUT, 'propose.png'))
  const still = textOf(await call('canvas_wait', { request_id: req1, timeout_s: 1, image: 'never' }))
  check(/has not sent anything yet/.test(still), '用户没表态时 canvas_wait 返回"还在等"')
  const w1 = call('canvas_wait', { request_id: req1, timeout_s: 30, image: 'never' })
  await user.typeNote('缓存放在校验之后')
  await user.click('不对，去掉')
  const r1 = textOf(await w1)
  check(/REJECTED/.test(r1) && /缓存放在校验之后/.test(r1), '拒绝：agent 收到结果和附言')
  check(!/查缓存/.test(r1) && countOnDisk() === before, '拒绝后提议的元素全部去掉了')
  check(Boolean(await user.waitForNoBanner()), '表态后横幅消失')

  // 第二次：用户接受
  const p2 = textOf(await call('canvas_propose', { ops: proposalOps, question: '（自动测试）这样对吗？' }))
  const req2 = p2.match(/req_\w+/)?.[0]
  const w2 = call('canvas_wait', { request_id: req2, timeout_s: 30, image: 'never' })
  await user.waitForBanner()
  await user.click('对，就这样')
  const r2 = textOf(await w2)
  check(/ACCEPTED/.test(r2), '接受：agent 收到结果')
  check(/「查缓存」菱形【agent 画的】/.test(r2) && !/提议/.test(r2), '接受后提议变成正式内容')
  const after = JSON.parse(readFileSync(join(HOME, 'boards', 'default.excalidraw'), 'utf8')).elements.filter((el) => !el.isDeleted)
  const merged = after.find((el) => el.type === 'diamond' && el.customData?.sketchlink?.layer === 'final' && el.strokeStyle === 'solid' && el.opacity === 100)
  check(after.length > before && !after.some((el) => el.customData?.sketchlink?.layer === 'proposal') && Boolean(merged), '画板文件里没有残留的提议层元素')
  await user.screenshot(join(OUT, 'propose-accepted.png'))
  user.close()
} finally {
  await client.close()
  // 关掉测试开的那个画布实例
  try {
    process.kill(JSON.parse(readFileSync(join(HOME, 'daemon.json'), 'utf8')).pid)
  } catch {}
}
console.log(`\n${failures ? `✖ ${failures} 项失败` : '✔ 全部通过'}，截图在 ${join(OUT, 'draw.png')}`)
process.exit(failures ? 1 : 0)
