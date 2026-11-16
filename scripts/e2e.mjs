// 端到端测试：用 MCP 客户端调桥接进程（扮演 agent），用 Chrome DevTools Protocol
// 在画布窗口里点按钮（扮演用户），把 open / read / request / wait 的各条路径都走一遍。
//
// 用法（先 npm run build）：
//   1. 关掉已经开着的 Flying draws 窗口
//   2. npx electron . --remote-debugging-port=9333     （另开一个终端，保持运行）
//   3. node scripts/e2e.mjs [截图输出目录]
//
// 只读画布、不改画的内容；会在画布上弹出几次请求横幅并自动点掉。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdk = (p) => pathToFileURL(join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm', p)).href
const { Client } = await import(sdk('client/index.js'))
const { StdioClientTransport } = await import(sdk('client/stdio.js'))

const OUT = resolve(process.argv[2] ?? join(ROOT, 'out', 'e2e'))
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? '✔' : '✖'} ${label}`)
  if (!ok) failures += 1
}

// ---------- CDP：扮演用户 ----------
let targets = []
for (let i = 0; i < 60; i++) {
  try {
    targets = await (await fetch('http://127.0.0.1:9333/json')).json()
    if (targets.some((t) => t.type === 'page')) break
  } catch {}
  await sleep(500)
}
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.error('找不到画布窗口：请先运行 npx electron . --remote-debugging-port=9333')
  process.exit(1)
}
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
const clickButton = (label) =>
  js(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}); if(!b) return false; b.click(); return true })()`)
const bannerText = () => js(`document.querySelector('.fd-banner, .fd-waiting')?.innerText ?? null`)
async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(200)
  }
  return null
}
for (let i = 0; i < 40; i++) {
  if (await js("!!document.querySelector('.excalidraw canvas')")) break
  await sleep(500)
}
await sleep(800)

// ---------- MCP：扮演 agent ----------
const client = new Client({ name: 'flying-draws-e2e', version: '0.0.1' })
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'out/bridge/index.js')], stderr: 'inherit' }))
const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
const textOf = (res) => res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')

const tools = (await client.listTools()).tools.map((t) => t.name).sort()
// 只断言 M1 的这四个工具在（后续里程碑还会加），和 e2e-draw.mjs 一样用子集判断
const expectedTools = ['canvas_open', 'canvas_read', 'canvas_request', 'canvas_wait']
check(expectedTools.every((n) => tools.includes(n)), `工具列表（${tools.length} 个）：${tools.join(', ')}`)

const open = await call('canvas_open')
check(!open.isError && /is open/.test(textOf(open)), 'canvas_open')

const read = await call('canvas_read', { image: 'always' })
check(!read.isError && /^画板「default」v\d+/.test(textOf(read)), 'canvas_read 返回文字描述')
const img = read.content.find((c) => c.type === 'image')
check(Boolean(img), 'canvas_read image=always 附带截图')
if (img) writeFileSync(join(OUT, 'read.png'), Buffer.from(img.data, 'base64'))
console.log(textOf(read).split('\n').slice(0, 6).join('\n'), '\n  ……')

const graph = await call('canvas_read', { format: 'graph', image: 'never' })
check(/结构（JSON）/.test(textOf(graph)) && !graph.content.some((c) => c.type === 'image'), 'canvas_read format=graph image=never')

// 请求 → 用户写附言并发送
const reqText = textOf(await call('canvas_request', { prompt: '（自动测试）把登录流程画一下' }))
const reqId = reqText.match(/req_\w+/)?.[0]
check(Boolean(reqId), `canvas_request 返回 ${reqId}`)
const waiting = call('canvas_wait', { request_id: reqId, timeout_s: 30, image: 'never' })
check(/把登录流程画一下/.test((await waitFor(bannerText)) ?? ''), '画布上出现请求横幅')
await js(`document.querySelector('.fd-banner-note')?.focus()`)
await cdp('Input.insertText', { text: '左边是入口，右边是登录页' })
await clickButton('发送')
const answered = textOf(await waiting)
check(/The user sent the canvas/.test(answered) && /左边是入口，右边是登录页/.test(answered), 'canvas_wait 收到画和附言')
check((await bannerText()) === null, '发送后横幅消失')

const again = textOf(await call('canvas_wait', { request_id: reqId, timeout_s: 2, image: 'never' }))
check(/The user sent the canvas/.test(again), '同一请求再等一次直接返回结果')

check(/has not sent anything yet/.test(textOf(await call('canvas_wait', { timeout_s: 2 }))), '没人发送时超时返回"还在画"')
check(/Unknown request_id/.test(textOf(await call('canvas_wait', { request_id: 'req_nope', timeout_s: 2 }))), '未知请求')

// 用户点"不画了"
const req2 = textOf(await call('canvas_request', { prompt: '（自动测试）再画一个注册流程' })).match(/req_\w+/)?.[0]
const waiting2 = call('canvas_wait', { request_id: req2, timeout_s: 30 })
await waitFor(bannerText)
await clickButton('不画了')
check(/dismissed/.test(textOf(await waiting2)), '用户取消请求')

// agent 等收件箱时显示"正在等你"，用户主动"发给 agent"
const waiting3 = call('canvas_wait', { timeout_s: 30, image: 'never' })
check(Boolean(await waitFor(async () => ((await bannerText()) ?? '').includes('正在等你'))), '画布显示"agent 正在等你"')
await clickButton('发给 agent')
await waitFor(bannerText)
await clickButton('发送')
check(/The user sent the canvas/.test(textOf(await waiting3)), '用户主动发送被 agent 收到')

const shot = await cdp('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(OUT, 'after.png'), Buffer.from(shot.result.data, 'base64'))
await client.close()
ws.close()
console.log(`\n${failures ? `✖ ${failures} 项失败` : '✔ 全部通过'}，截图在 ${OUT}`)
process.exit(failures ? 1 : 0)
