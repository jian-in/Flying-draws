// canvas_draw 的端到端测试：扮演 agent 调 MCP，在一块隔离的临时画板上画图再读回来。
//
// 用法（先 npm run build）：
//   node scripts/e2e-draw.mjs
//
// 用 SKETCHLINK_HOME 把画板和连接信息都指到 out/e2e-home，
// 不会碰用户的 ~/.sketchlink，也不用先关掉用户开着的画布。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    js,
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
  check(stale.isError && /conflict/.test(textOf(stale)) && /base_version is required/.test(textOf(stale)), '引用已有节点但没带 base_version：整批拒绝')
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

  // ---------- 改动已有内容：改字、删除，按元素判断冲突 ----------
  const user = await connectPage()
  const readNow = async () => {
    const t = textOf(await call('canvas_read', { image: 'never' }))
    return { t, v: Number(t.match(/v(\d+)：/)?.[1]), id: (label) => t.match(new RegExp(`(N\\d+) 「${label}」`))?.[1] }
  }
  // 扮演用户直接改画布上的一个元素
  const userEdits = (label, patchSrc) =>
    user.js(`(() => {
      const api = window.__sketchlinkApi
      const all = api.getSceneElementsIncludingDeleted()
      const text = all.find((e) => !e.isDeleted && e.type === 'text' && e.text === ${JSON.stringify(label)})
      const patch = ${patchSrc}
      api.updateScene({ elements: all.map((e) => (e.id === text.containerId ? { ...e, ...patch(e), version: e.version + 1, versionNonce: Math.floor(Math.random() * 1e9), updated: Date.now() } : e)) })
      return true
    })()`)

  // 旧版本号照样能用：读一次，画板再变一次，然后拿旧版本号里的编号去连线
  const s0 = await readNow()
  await call('canvas_draw', { ops: [{ op: 'add_node', id: 'pad', label: '占位' }] })
  const late = await call('canvas_draw', {
    base_version: s0.v,
    ops: [
      { op: 'add_node', id: 'done', label: '完成' },
      { op: 'add_edge', from: s0.id('首页'), to: 'done' }
    ]
  })
  check(!late.isError && /「首页」 → N\d+「完成」/.test(textOf(late)), '画板变过以后，用旧版本号里的编号照样能连到同一个节点')

  // 改字和删除
  const s1 = await readNow()
  const changed = await call('canvas_draw', {
    base_version: s1.v,
    ops: [
      { op: 'update_node', id: s1.id('首页'), label: '个人主页' },
      { op: 'update_edge', from: s1.id('已登录？'), to: s1.id('首页'), label: '已登录' },
      { op: 'delete_node', id: s1.id('登录页') },
      { op: 'delete_edge', from: s1.id('查数据库'), to: s1.id('返回结果') }
    ]
  })
  const changedText = textOf(changed)
  check(!changed.isError && /Changed: 2 text\(s\) updated, 2 deleted/.test(changedText), 'canvas_draw 改了 2 处文字、删了 2 个元素')
  check(/「个人主页」矩形【agent 画的】/.test(changedText) && !/「首页」/.test(changedText), '节点的文字换掉了')
  check(/「已登录？」 → N\d+「个人主页」，标着「已登录」/.test(changedText) && !/标着「是」/.test(changedText), '连线上的文字换掉了')
  check(!/登录页」矩形/.test(changedText) && !/标着「否」/.test(changedText), '删节点时连着它的连线一起删了')
  check(!/「查数据库」 → N\d+「返回结果」/.test(changedText) && /「查数据库」矩形/.test(changedText), '删连线不影响两头的节点')
  const disk = () => JSON.parse(readFileSync(join(HOME, 'boards', 'default.excalidraw'), 'utf8')).elements.filter((el) => !el.isDeleted)
  const dangling = disk().filter((el) => (el.boundElements ?? []).some((b) => !disk().some((x) => x.id === b.id)))
  check(dangling.length === 0, '画板文件里没有指向已删除元素的绑定记录')
  const modShot = (await call('canvas_read', { image: 'always' })).content.find((c) => c.type === 'image')
  if (modShot) writeFileSync(join(OUT, 'draw-modified.png'), Buffer.from(modShot.data, 'base64'))

  // 用户画的东西不能动
  await user.js(`(() => {
    const api = window.__sketchlinkApi
    const all = api.getSceneElementsIncludingDeleted()
    const model = all.find((e) => !e.isDeleted && e.type === 'rectangle')
    const mine = { ...model, id: 'user_box_0', x: model.x - 400, boundElements: null, strokeColor: '#1e1e1e' }
    delete mine.customData
    delete mine.index
    api.updateScene({ elements: [...all, mine] })
    return true
  })()`)
  const s2 = await readNow()
  const userBox = s2.t.match(/(N\d+) （无文字）矩形(?!【)/)?.[1]
  const forbidden = await call('canvas_draw', { base_version: s2.v, ops: [{ op: 'delete_node', id: userBox }] })
  check(Boolean(userBox) && forbidden.isError && /was drawn by the user/.test(textOf(forbidden)), `用户画的节点（${userBox}）agent 删不了`)
  check((await readNow()).t.includes(`${userBox} （无文字）矩形`), '被拒绝后用户的节点还在')

  // 冲突一：agent 读过之后，用户动了它想改的那个节点
  const s3 = await readNow()
  await userEdits('个人主页', '(e) => ({ x: e.x + 60 })')
  const touched = await call('canvas_draw', { base_version: s3.v, ops: [{ op: 'update_node', id: s3.id('个人主页'), label: '我的' }] })
  check(touched.isError && /conflict/.test(textOf(touched)) && /"个人主页"\) was changed by someone else/.test(textOf(touched)), '用户动过的节点，agent 按旧版本去改会冲突')
  check(/「个人主页」/.test((await readNow()).t), '冲突时什么都没改')
  // 但只是引用它（连一条线过去）不算冲突
  const stillOk = await call('canvas_draw', { base_version: s3.v, ops: [{ op: 'add_node', id: 'more', label: '设置' }, { op: 'add_edge', from: s3.id('个人主页'), to: 'more' }] })
  check(!stillOk.isError && /「个人主页」 → N\d+「设置」/.test(textOf(stillOk)), '被用户动过的节点仍然可以连线过去')

  // 冲突二：agent 读过之后，用户把它要连的节点删了
  const s4 = await readNow()
  await userEdits('完成', '() => ({ isDeleted: true })')
  const vanished = await call('canvas_draw', { base_version: s4.v, ops: [{ op: 'add_node', id: 'z', label: '归档' }, { op: 'add_edge', from: s4.id('完成'), to: 'z' }] })
  check(vanished.isError && /"完成"\) was deleted after version/.test(textOf(vanished)), '要连的节点被用户删了：冲突，并说明是哪个')
  check(!/「归档」/.test((await readNow()).t), '冲突时整批都没画')

  // ---------- 用户主动"发给 agent"：发出后要有反馈 ----------
  const notice = () => user.js(`document.querySelector('.sl-waiting')?.innerText ?? null`)
  const toast = () => user.js(`document.querySelector('.sl-toast')?.innerText ?? null`)
  const until = async (fn, ms = 6000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if (await fn()) return true
    return false
  }
  await user.click('发给 agent')
  check(/没在等/.test((await user.waitForBanner()) ?? ''), '没有 agent 在等时，发送前就说明要在聊天里说一声')
  await user.typeNote('看一下这版')
  await user.click('发送')
  check(await until(async () => /已发出，agent 还没来取/.test((await notice()) ?? '')), '发出后画布上显示"已发出，agent 还没来取"')
  await user.screenshot(join(OUT, 'sent-waiting.png'))
  const fetched = textOf(await call('canvas_read', { image: 'never' }))
  check(/pressed "Send to agent"/.test(fetched) && /看一下这版/.test(fetched), 'agent 直接读画布时，一并拿到用户发的附言')
  check(await until(async () => /已经取走/.test((await toast()) ?? '')) && (await notice()) === null, '被取走后提示消失，并告诉用户 agent 取走了')
  check(!/pressed "Send to agent"/.test(textOf(await call('canvas_read', { image: 'never' }))), '同一份不会交给 agent 两次')
  // agent 正等着的时候发：直接交到它手上
  const inboxWait = call('canvas_wait', { timeout_s: 30, image: 'never' })
  await until(async () => /正在等你/.test((await notice()) ?? ''))
  await user.click('发给 agent')
  await user.waitForBanner()
  await user.click('发送')
  check(/The user sent the canvas/.test(textOf(await inboxWait)), 'agent 正在等时，发出的画直接交到它手上')
  check(await until(async () => /已经收到/.test((await toast()) ?? '')), '并告诉用户 agent 已经收到')

  // ---------- 提议层：agent 画出理解，用户确认 ----------
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
  check(/ACCEPTED/.test(r2) && /exactly as you drew it/.test(r2), '接受：agent 收到结果，并被告知用户没有改动')
  check(/「查缓存」菱形【agent 画的】/.test(r2) && !/提议/.test(r2), '接受后提议变成正式内容')
  const after = JSON.parse(readFileSync(join(HOME, 'boards', 'default.excalidraw'), 'utf8')).elements.filter((el) => !el.isDeleted)
  const merged = after.find((el) => el.type === 'diamond' && el.customData?.sketchlink?.layer === 'final' && el.strokeStyle === 'solid' && el.opacity === 100)
  check(after.length > before && !after.some((el) => el.customData?.sketchlink?.layer === 'proposal') && Boolean(merged), '画板文件里没有残留的提议层元素')
  await user.screenshot(join(OUT, 'propose-accepted.png'))

  // 第三次：两个提议排队，用户在第一个上改了再接受
  const pA = textOf(
    await call('canvas_propose', {
      question: '（自动测试）提议甲：这样记日志对吗？',
      ops: [
        { op: 'add_node', id: 'log', label: '写日志' },
        { op: 'add_node', id: 'alert', label: '发告警' },
        { op: 'add_edge', from: 'log', to: 'alert', label: '出错时' }
      ]
    })
  )
  const pB = textOf(await call('canvas_propose', { question: '（自动测试）提议乙：要不要加重试？', ops: [{ op: 'add_node', id: 'retry', label: '重试三次' }] }))
  const [reqA, reqB] = [pA, pB].map((t) => t.match(/req_\w+/)?.[0])
  const bannerA = (await user.waitForBanner()) ?? ''
  check(/提议甲/.test(bannerA) && /后面还有 1 个请求/.test(bannerA), '两个提议排队：横幅先问第一个，并写明后面还有 1 个')

  // 扮演用户直接改画布：把「发告警」往下拖、改成「发短信」，再自己画一个框
  const edited = await user.js(`(async () => {
    const api = window.__sketchlinkApi
    const pid = (await window.sketchlink.getHubState()).pending[0].proposalId
    const all = api.getSceneElementsIncludingDeleted()
    const label = all.find((e) => e.type === 'text' && e.text === '发告警' && e.customData?.sketchlink?.proposal === pid)
    const node = all.find((e) => e.id === label.containerId)
    const bump = (e, patch) => ({ ...e, ...patch, version: e.version + 1, versionNonce: Math.floor(Math.random() * 1e9), updated: Date.now() })
    const next = all.map((e) =>
      e.id === node.id ? bump(e, { y: e.y + 200 }) : e.id === label.id ? bump(e, { y: e.y + 200, text: '发短信', originalText: '发短信' }) : e
    )
    const own = { ...node, id: 'user_box_1', x: node.x + 400, y: node.y, boundElements: null, opacity: 100, strokeStyle: 'solid', strokeColor: '#1e1e1e' }
    delete own.customData
    delete own.index
    api.updateScene({ elements: [...next, own] })
    return true
  })()`)
  check(edited === true, '（扮演用户）在提议上拖动、改字，并自己加了一个框')
  await sleep(300)
  await user.screenshot(join(OUT, 'propose-edited.png'))
  const wA = call('canvas_wait', { request_id: reqA, timeout_s: 30, image: 'never' })
  await user.click('对，就这样')
  const rA = textOf(await wA)
  console.log(rA.split('\n').slice(0, 6).join('\n'))
  check(/ACCEPTED/.test(rA) && /the user changed it/.test(rA), '改了再接受：agent 被告知用户改过')
  check(/把节点「发告警」的文字改成了「发短信」/.test(rA), '改动里有：改了文字')
  check(/把节点「发短信」往下挪了/.test(rA), '改动里有：挪了位置')
  check(/自己加了：节点一个没有文字的图形/.test(rA), '改动里有：用户自己加的框')
  const boardA = rA.slice(rA.indexOf('画板「')) // 只看画布描述那一段，前面的改动说明里本来就会提到旧文字
  check(/「发短信」矩形【agent 画的】/.test(boardA) && !/发告警/.test(boardA), '接受后画布上是用户改过的样子')

  const bannerB = (await user.waitForBanner()) ?? ''
  check(/提议乙/.test(bannerB) && !/后面还有/.test(bannerB), '处理完第一个，横幅接着问第二个')

  // 第四次：提议还没处理，应用被强杀后重启
  user.close()
  const oldPid = JSON.parse(readFileSync(join(HOME, 'daemon.json'), 'utf8')).pid
  process.kill(oldPid)
  await sleep(1500)
  const afterRestart = textOf(await call('canvas_wait', { request_id: reqB, timeout_s: 3, image: 'never' }))
  const newPid = JSON.parse(readFileSync(join(HOME, 'daemon.json'), 'utf8')).pid
  check(newPid !== oldPid && /has not sent anything yet/.test(afterRestart), '应用重启后，原来的 request_id 还认得（不是 unknown_request）')
  const user2 = await connectPage()
  const bannerAgain = (await user2.waitForBanner()) ?? ''
  check(/提议乙/.test(bannerAgain), '重启后确认横幅又出现了')
  await sleep(500)
  await user2.screenshot(join(OUT, 'propose-after-restart.png'))
  const wB = call('canvas_wait', { request_id: reqB, timeout_s: 30, image: 'never' })
  await user2.click('对，就这样')
  const rB = textOf(await wB)
  console.log(rB.split('\n').slice(0, 4).join('\n'))
  check(/ACCEPTED/.test(rB) && /「重试三次」矩形【agent 画的】/.test(rB), '重启后照样能接受提议')
  // 提议乙画上去之后，用户才加了那个框，所以对乙来说它也是"后来加的"；乙本身没被改
  check(/自己加了：节点一个没有文字的图形/.test(rB) && !/把节点|删掉了/.test(rB), '重启后底稿还在：改动对比照常工作')
  const pendingFile = JSON.parse(readFileSync(join(HOME, 'pending.json'), 'utf8'))
  check(Object.keys(pendingFile.boards ?? {}).length === 0, '处理完后，存盘的待处理请求清空了')

  // 第五次：多画板新建、切换与隔离
  const listed1 = textOf(await call('canvas_list'))
  check(/Current board: default/.test(listed1), 'canvas_list 能看到当前画板 default')

  const openedNew = textOf(await call('canvas_open', { board: 'login-flow', title: '登录流程' }))
  check(/Created and opened canvas "login-flow"/.test(openedNew), 'canvas_open 支持传入新 board 和 title 创建并切换')
  await sleep(300)
  const selectValAfterMcp = await user2.js(`document.querySelector('.sl-board-select')?.value`)
  check(selectValAfterMcp === 'login-flow', 'MCP 切画板后，页面右上角下拉框同步切到 login-flow')

  const drawnNew = textOf(
    await call('canvas_draw', {
      ops: [
        { op: 'add_node', id: 'u', label: '输入账号' },
        { op: 'add_node', id: 'ok', label: '进入首页' },
        { op: 'add_edge', from: 'u', to: 'ok', label: '验证通过' }
      ]
    })
  )
  check(/画板「login-flow」/.test(drawnNew) && /「输入账号」/.test(drawnNew) && !/重试三次/.test(drawnNew), '新画板 login-flow 独立绘制，不混入 default 的内容')

  // 扮演用户点「+ 新建画板」按钮在 UI 上创建一块新画板
  await user2.js(`document.querySelector('.sl-new-board').click()`)
  await sleep(200)
  await user2.js(`(() => {
    const input = document.querySelector('.sl-modal input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'ui-board')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await user2.click('创建')
  await sleep(400)
  const uiSelect = await user2.js(`document.querySelector('.sl-board-select')?.value`)
  check(uiSelect === 'ui-board', '页面点「+ 新建画板」能创建并切到 ui-board')

  const uiRead = textOf(await call('canvas_read'))
  check(/画板「ui-board」/.test(uiRead) && /（画板是空的）/.test(uiRead), '新建的 ui-board 是空白画板')

  // 用 canvas_read 指定 board 切回 default，确认原先的画还在
  const readDefault = textOf(await call('canvas_read', { board: 'default', image: 'never' }))
  check(/画板「default」/.test(readDefault) && /「重试三次」/.test(readDefault), '切回 default 后原来的内容完整保留')

  const listed2 = textOf(await call('canvas_list'))
  check(/login-flow "登录流程"/.test(listed2) && /ui-board/.test(listed2) && /default \[active\]/.test(listed2), 'canvas_list 列出全部三块画板并标明当前激活画板')

  // 第六次：收件箱持久化（用户主动发画后重启，收件箱和等待条都在）
  await user2.click('发给 agent')
  await sleep(200)
  await user2.typeNote('重启前发出的画')
  await user2.click('发送')
  const waitingBeforeRestart = await until(
    async () => /已发出，agent 还没来取/.test((await user2.js(`document.querySelector('.sl-waiting')?.textContent ?? ''`)) ?? '')
  )
  check(waitingBeforeRestart, '没有 agent 等待时发画会显示等待查看横幅')
  const pendingWithInbox = JSON.parse(readFileSync(join(HOME, 'pending.json'), 'utf8'))
  check(
    Array.isArray(pendingWithInbox.inbox?.default) && pendingWithInbox.inbox.default[0]?.note === '重启前发出的画',
    '未取走的收件箱消息已经写入 pending.json'
  )

  const pidBeforeInboxRestart = JSON.parse(readFileSync(join(HOME, 'daemon.json'), 'utf8')).pid
  user2.close()
  process.kill(pidBeforeInboxRestart)
  await sleep(1500)
  await call('canvas_open')
  const user3 = await connectPage()
  const waitingAfterRestart = await until(
    async () => /已发出，agent 还没来取/.test((await user3.js(`document.querySelector('.sl-waiting')?.textContent ?? ''`)) ?? '')
  )
  check(waitingAfterRestart, '应用重启后收件箱等待横幅自动恢复')

  const readInboxAfterRestart = textOf(await call('canvas_read', { image: 'never' }))
  check(/重启前发出的画/.test(readInboxAfterRestart), '重启后调用 canvas_read 能收到用户之前发来的画与附言')
  await sleep(300)
  const waitingAfterRead = await user3.js(`document.querySelector('.sl-waiting')?.textContent ?? ''`)
  const pendingClearedInbox = JSON.parse(readFileSync(join(HOME, 'pending.json'), 'utf8'))
  check(!waitingAfterRead && !pendingClearedInbox.inbox, '收件箱取走后等待横幅消失且 pending.json 已清空')

  // 第七次：画板重命名与删除（UI 与 MCP）
  await call('canvas_open', { board: 'ui-board' })
  await sleep(300)
  // 重命名和删除收在「⋯」菜单里，先点开
  const openMenu = async () => {
    await user3.js(`void (document.querySelector('.sl-menu') || document.querySelector('.sl-more').click())`)
    await sleep(150)
  }
  await openMenu()
  await user3.click('重命名')
  await sleep(200)
  await user3.js(`(() => {
    const input = document.querySelector('.sl-modal input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'renamed-ui')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await user3.click('保存')
  await sleep(400)
  const selectAfterUiRename = await user3.js(`document.querySelector('.sl-board-select')?.value`)
  check(
    selectAfterUiRename === 'renamed-ui' &&
      !existsSync(join(HOME, 'boards', 'ui-board.excalidraw')) &&
      existsSync(join(HOME, 'boards', 'renamed-ui.excalidraw')),
    'UI 重命名画板后切换编号并迁移磁盘文件'
  )

  const mcpRenamed = textOf(await call('canvas_rename', { board: 'renamed-ui', new_board: 'renamed-by-mcp', title: 'MCP 重命名' }))
  await sleep(300)
  const selectAfterMcpRename = await user3.js(`document.querySelector('.sl-board-select')?.value`)
  check(
    /Renamed board "renamed-ui" to "renamed-by-mcp"/.test(mcpRenamed) && selectAfterMcpRename === 'renamed-by-mcp',
    'MCP canvas_rename 能重命名画板并同步更新页面下拉框'
  )

  await openMenu()
  await user3.click('删除')
  await sleep(200)
  await user3.click('确认删除')
  await sleep(400)
  const selectAfterUiDelete = await user3.js(`document.querySelector('.sl-board-select')?.value`)
  const listedAfterUiDelete = textOf(await call('canvas_list'))
  check(
    selectAfterUiDelete === 'default' &&
      !existsSync(join(HOME, 'boards', 'renamed-by-mcp.excalidraw')) &&
      !/renamed-by-mcp/.test(listedAfterUiDelete),
    'UI 删除当前画板后自动切回 default 并移除磁盘文件'
  )

  const mcpDeleted = textOf(await call('canvas_delete', { board: 'login-flow' }))
  await sleep(300)
  const listedFinal = textOf(await call('canvas_list'))
  await openMenu()
  const deleteDisabledOnLast = await user3.js(
    `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '删除')?.disabled ?? false`
  )
  check(
    /Deleted board "login-flow"/.test(mcpDeleted) &&
      !/login-flow/.test(listedFinal) &&
      deleteDisabledOnLast === true,
    'MCP canvas_delete 能删除指定画板；只剩最后一块画板时 UI 删除按钮禁用'
  )

  // 界面截图：浅色和深色各一张，菜单开着
  await user3.screenshot(join(OUT, 'ui-menu.png'))
  await user3.js(`window.__sketchlinkApi.updateScene({ appState: { theme: 'dark' } })`)
  await sleep(300)
  await user3.click('发给 agent')
  await sleep(200)
  await openMenu()
  await user3.screenshot(join(OUT, 'ui-dark.png'))
  check((await user3.js(`document.documentElement.dataset.slTheme`)) === 'dark', '切到深色后，横幅和菜单跟着变深色')
  await user3.click('取消')
  await user3.js(`window.__sketchlinkApi.updateScene({ appState: { theme: 'light' } })`)
  await sleep(200)

  user3.close()
} finally {
  await client.close()
  // 关掉测试开的那个画布实例
  try {
    process.kill(JSON.parse(readFileSync(join(HOME, 'daemon.json'), 'utf8')).pid)
  } catch {}
}
console.log(`\n${failures ? `✖ ${failures} 项失败` : '✔ 全部通过'}，截图在 ${join(OUT, 'draw.png')}`)
process.exit(failures ? 1 : 0)
