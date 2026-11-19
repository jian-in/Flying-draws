// canvas_draw 的端到端测试：扮演 agent 调 MCP，在一块隔离的临时画板上画图再读回来。
//
// 用法（先 npm run build）：
//   node scripts/e2e-draw.mjs
//
// 用 FLYINGDRAWS_HOME 把画板和连接信息都指到 out/e2e-home，
// 不会碰用户的 ~/.flyingdraws，也不用先关掉用户开着的画布。
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
  const js = async (e) => {
    const reply = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
    if (reply.result?.exceptionDetails) {
      throw new Error(reply.result.exceptionDetails.exception?.description || 'CDP Runtime.evaluate exception')
    }
    return reply.result?.result?.value
  }
  const waitFor = async (fn, ms = 10000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const v = await fn()
      if (v) return v
      await sleep(100)
    }
    return null
  }
  return {
    bannerText: () => js(`document.querySelector('.fd-banner')?.innerText ?? null`),
    waitForBanner: () => waitFor(() => js(`document.querySelector('.fd-banner')?.innerText ?? null`)),
    waitForNoBanner: () => waitFor(() => js(`!document.querySelector('.fd-banner')`)),
    click: (label) =>
      waitFor(
        () =>
          js(
            `(() => { const b=[...document.querySelectorAll('button')].find(b=>!b.disabled&&b.textContent.trim()===${JSON.stringify(label)}); if(!b) return false; b.click(); return true })()`
          ),
        8000
      ),
    typeNote: async (t) => {
      await js(`document.querySelector('.fd-banner-note')?.focus()`)
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

const client = new Client({ name: 'flying-draws-e2e-draw', version: '0.0.1' })
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'out/bridge/index.js')],
    env: { ...process.env, FLYINGDRAWS_HOME: HOME, FLYINGDRAWS_DEBUG_PORT: String(DEBUG_PORT) },
    stderr: 'inherit'
  })
)
const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
const textOf = (res) => res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')

try {
  const tools = (await client.listTools()).tools.map((t) => t.name)
  const expectedTools = [
    'canvas_open',
    'canvas_list',
    'canvas_rename',
    'canvas_delete',
    'canvas_read',
    'canvas_request',
    'canvas_wait',
    'canvas_pass',
    'canvas_propose',
    'canvas_draw'
  ]
  check(expectedTools.every((n) => tools.includes(n)), `工具列表完整包含 10 个工具（实际 ${tools.length} 个）`)

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

  // 落盘的文件里有作者和 agent 署名标记，别的 Excalidraw 也能打开
  const saved = JSON.parse(readFileSync(join(HOME, 'boards', 'default.excalidraw'), 'utf8'))
  const mine = saved.elements.filter((el) => el.customData?.flyingdraws?.author === 'agent' && !el.isDeleted)
  check(saved.type === 'excalidraw' && mine.length === saved.elements.filter((el) => !el.isDeleted).length, `画板文件里 ${mine.length} 个元素都标了 agent`)
  check(mine.every((el) => el.customData?.flyingdraws?.agent === 'flying-draws-e2e-draw'), '元素记录了调用方 agent 名字')
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
      const api = window.__flyingdrawsApi
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

  // agent 可以直接修改、改样式和删除用户画的内容（节点、独立文字）
  await user.js(`(() => {
    const api = window.__flyingdrawsApi
    const all = api.getSceneElementsIncludingDeleted()
    const rectModel = all.find((e) => !e.isDeleted && e.type === 'rectangle')
    const textModel = all.find((e) => !e.isDeleted && e.type === 'text' && !e.containerId)
    const mine1 = { ...rectModel, id: 'user_box_0', x: rectModel.x - 450, y: rectModel.y, width: 120, height: 60, boundElements: null, strokeColor: '#1e1e1e', backgroundColor: 'transparent' }
    const mine2 = { ...rectModel, id: 'user_box_keep', x: rectModel.x - 450, y: rectModel.y + 180, width: 120, height: 60, boundElements: null, strokeColor: '#1e1e1e', backgroundColor: 'transparent' }
    const note = { ...textModel, id: 'user_note_0', x: rectModel.x - 450, y: rectModel.y - 60, text: '用户原注', originalText: '用户原注' }
    for (const el of [mine1, mine2, note]) {
      delete el.customData
      delete el.index
    }
    api.updateScene({ elements: [...all, mine1, mine2, note] })
    return true
  })()`)
  const s2 = await readNow()
  const userBox = s2.t.match(/(N\d+) （无文字）矩形(?!【)/)?.[1]
  const userNote = s2.t.match(/(T\d+) 「用户原注」/)?.[1]
  const styled = await call('canvas_draw', {
    base_version: s2.v,
    ops: [
      { op: 'set_style', id: userBox, color: '#e03131', fill: '#ffec99', shape: 'diamond', width: 200, height: 100 },
      { op: 'update_node', id: userBox, label: '改名' },
      { op: 'update_text', id: userNote, text: 'agent 改过的注释' }
    ]
  })
  const styledText = textOf(styled)
  check(
    !styled.isError && /1 styled/.test(styledText) && /「改名」菱形/.test(styledText) && /「agent 改过的注释」/.test(styledText),
    `agent 可直接给用户节点改样式/改字并修改独立文字（${userBox} / ${userNote}）`
  )
  const diskStyled = () => JSON.parse(readFileSync(join(HOME, 'boards', 'default.excalidraw'), 'utf8')).elements.filter((el) => !el.isDeleted)
  const styledBoxOnDisk = diskStyled().find((el) => el.id === 'user_box_0')
  check(
    styledBoxOnDisk?.type === 'diamond' &&
      styledBoxOnDisk?.strokeColor === '#e03131' &&
      styledBoxOnDisk?.backgroundColor === '#ffec99' &&
      styledBoxOnDisk?.width === 200 &&
      styledBoxOnDisk?.height === 100,
    'set_style 的形状、颜色、填充和尺寸已写入画板文件'
  )

  const s2b = await readNow()
  const boxToDelete = s2b.t.match(/(N\d+) 「改名」菱形/)?.[1]
  const delRes = await call('canvas_draw', { base_version: s2b.v, ops: [{ op: 'delete_node', id: boxToDelete }] })
  check(!delRes.isError && !/「改名」/.test(textOf(delRes)), `agent 可直接删除用户节点（${boxToDelete}）`)

  // 带改动的提议：生成虚线标记框，用户删掉其中一个标记框后点接受，被删掉的那处不执行并报回给 agent
  const s2p = await readNow()
  const keepBoxId = s2p.t.match(/(N\d+) （无文字）矩形(?!【)/)?.[1]
  const noteToDel = s2p.t.match(/(T\d+) 「agent 改过的注释」/)?.[1]
  const propMod = textOf(
    await call('canvas_propose', {
      base_version: s2p.v,
      question: '（自动测试）把左下角框标绿、并删掉旁边那行注释，好吗？',
      ops: [
        { op: 'set_style', id: keepBoxId, color: '#2f9e44' },
        { op: 'delete_text', id: noteToDel },
        { op: 'add_node', id: 'prop_extra', label: '追加补充框' }
      ]
    })
  )
  const reqMod = propMod.match(/req_\w+/)?.[0]
  check(Boolean(reqMod) && /2 edit marker\(s\)/.test(propMod), 'canvas_propose 带改动和删除时返回了 2 个标记框')
  await user.waitForBanner()
  // 模拟用户在画布上删掉代表"删除注释"的红色标记框，保留蓝色"改样式"标记框
  const removedOneMarker = await user.js(`(() => {
    const api = window.__flyingdrawsApi
    const all = api.getSceneElementsIncludingDeleted()
    const delFrame = all.find((e) => !e.isDeleted && e.customData?.flyingdraws?.role === 'marker' && e.type === 'rectangle' && e.strokeColor === '#e03131')
    if (!delFrame) return false
    const gid = delFrame.groupIds?.[0]
    api.updateScene({
      elements: all.map((e) => (e.id === delFrame.id || (gid && e.groupIds?.includes(gid)) ? { ...e, isDeleted: true, version: e.version + 1 } : e))
    })
    return true
  })()`)
  check(removedOneMarker === true, '（扮演用户）在画布上删掉其中一处删除标记框')
  const wMod = call('canvas_wait', { request_id: reqMod, timeout_s: 30, image: 'never' })
  await user.click('对，就这样')
  const rMod = textOf(await wMod)
  check(
    /ACCEPTED/.test(rMod) && /不同意删除文字「agent 改过的注释」/.test(rMod) && /「agent 改过的注释」/.test(rMod) && /「追加补充框」矩形【agent 画的】/.test(rMod),
    '接受提议后：被删标记框对应的删除被跳过并写进 changes，其余改动和新增生效'
  )
  const afterPropDisk = diskStyled()
  check(
    afterPropDisk.find((e) => e.id === 'user_box_keep')?.strokeColor === '#2f9e44' &&
      !afterPropDisk.some((e) => e.customData?.flyingdraws?.role === 'marker'),
    '保留的样式改动已落地且标记框全部清理'
  )

  // 底部按作者筛选标签：切到「我画的」只隐藏画布显示，不改磁盘也不影响 agent 读取
  await user.click('我画的')
  await sleep(200)
  const filterState = await user.js(`(() => {
    const els = window.__flyingdrawsApi.getSceneElements()
    const userEl = els.find((e) => e.id === 'user_box_keep')
    const agentEls = els.filter((e) => e.customData?.flyingdraws?.author === 'agent')
    return {
      userVisible: userEl ? userEl.opacity === 100 && !userEl.locked : false,
      agentHidden: agentEls.length > 0 && agentEls.every((e) => e.opacity === 0 && e.locked === true)
    }
  })()`)
  check(filterState.userVisible && filterState.agentHidden, '点「我画的」筛选标签：只显示用户元素，agent 元素隐藏且锁定')
  const readWhileFiltered = textOf(await call('canvas_read', { image: 'never' }))
  check(/「个人主页」矩形【agent 画的】/.test(readWhileFiltered), '筛选隐藏期间，agent 依然能读到完整画板')
  await user.click('全部')
  await sleep(200)
  const restoredVisible = await user.js(
    `window.__flyingdrawsApi.getSceneElements().filter((e) => e.customData?.flyingdraws?.author === 'agent').every((e) => e.opacity === 100 && !e.locked)`
  )
  check(restoredVisible === true, '点回「全部」筛选标签后，所有元素恢复显示和可编辑')

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
  const notice = () => user.js(`document.querySelector('.fd-waiting')?.innerText ?? null`)
  const toast = () => user.js(`document.querySelector('.fd-toast')?.innerText ?? null`)
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
  const merged = after.find((el) => el.type === 'diamond' && el.customData?.flyingdraws?.layer === 'final' && el.strokeStyle === 'solid' && el.opacity === 100)
  check(after.length > before && !after.some((el) => el.customData?.flyingdraws?.layer === 'proposal') && Boolean(merged), '画板文件里没有残留的提议层元素')
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
    const api = window.__flyingdrawsApi
    const pid = (await window.flyingdraws.getHubState()).pending[0].proposalId
    const all = api.getSceneElementsIncludingDeleted()
    const label = all.find((e) => e.type === 'text' && e.text === '发告警' && e.customData?.flyingdraws?.proposal === pid)
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
  const selectValAfterMcp = await user2.js(`document.querySelector('.fd-board-select')?.value`)
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
  await user2.js(`document.querySelector('.fd-new-board').click()`)
  await sleep(200)
  await user2.js(`(() => {
    const input = document.querySelector('.fd-modal input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'ui-board')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await user2.click('创建')
  await sleep(400)
  const uiSelect = await user2.js(`document.querySelector('.fd-board-select')?.value`)
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
    async () => /已发出，agent 还没来取/.test((await user2.js(`document.querySelector('.fd-waiting')?.textContent ?? ''`)) ?? '')
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
    async () => /已发出，agent 还没来取/.test((await user3.js(`document.querySelector('.fd-waiting')?.textContent ?? ''`)) ?? '')
  )
  check(waitingAfterRestart, '应用重启后收件箱等待横幅自动恢复')

  const readInboxAfterRestart = textOf(await call('canvas_read', { image: 'never' }))
  check(/重启前发出的画/.test(readInboxAfterRestart), '重启后调用 canvas_read 能收到用户之前发来的画与附言')
  await sleep(300)
  const waitingAfterRead = await user3.js(`document.querySelector('.fd-waiting')?.textContent ?? ''`)
  const pendingClearedInbox = JSON.parse(readFileSync(join(HOME, 'pending.json'), 'utf8'))
  check(!waitingAfterRead && !pendingClearedInbox.inbox, '收件箱取走后等待横幅消失且 pending.json 已清空')

  // 第七次：画板重命名与删除（UI 与 MCP）
  await call('canvas_open', { board: 'ui-board' })
  await until(async () => (await user3.js(`document.querySelector('.fd-board-select')?.value`)) === 'ui-board')
  // 重命名和删除收在「⋯」菜单里：轮询确保菜单真正挂出，避免窗口焦点/重排事件把菜单瞬间关掉
  const openMenu = async () => {
    const opened = await until(async () => {
      if (await user3.js(`Boolean(document.querySelector('.fd-menu'))`)) return true
      await user3.js(`document.querySelector('.fd-more')?.click()`)
      await sleep(100)
      return Boolean(await user3.js(`Boolean(document.querySelector('.fd-menu'))`))
    })
    if (!opened) throw new Error('未能打开「⋯」菜单')
  }
  await openMenu()
  await user3.click('重命名')
  await until(async () => Boolean(await user3.js(`Boolean(document.querySelector('.fd-modal input'))`)))
  await user3.js(`(() => {
    const input = document.querySelector('.fd-modal input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'renamed-ui')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await user3.click('保存')
  const uiRenameDone = await until(
    async () =>
      (await user3.js(`document.querySelector('.fd-board-select')?.value`)) === 'renamed-ui' &&
      !existsSync(join(HOME, 'boards', 'ui-board.excalidraw')) &&
      existsSync(join(HOME, 'boards', 'renamed-ui.excalidraw')),
    10000
  )
  check(uiRenameDone, 'UI 重命名画板后切换编号并迁移磁盘文件')

  const mcpRenamed = textOf(await call('canvas_rename', { board: 'renamed-ui', new_board: 'renamed-by-mcp', title: 'MCP 重命名' }))
  const mcpRenameSynced = await until(
    async () => (await user3.js(`document.querySelector('.fd-board-select')?.value`)) === 'renamed-by-mcp',
    8000
  )
  check(
    /Renamed board "renamed-ui" to "renamed-by-mcp"/.test(mcpRenamed) && mcpRenameSynced,
    'MCP canvas_rename 能重命名画板并同步更新页面下拉框'
  )

  await openMenu()
  await user3.click('删除')
  await until(async () => Boolean(await user3.js(`Boolean(document.querySelector('.fd-modal'))`)))
  await user3.click('确认删除')
  const uiDeleteDone = await until(
    async () =>
      (await user3.js(`document.querySelector('.fd-board-select')?.value`)) === 'default' &&
      !existsSync(join(HOME, 'boards', 'renamed-by-mcp.excalidraw')),
    10000
  )
  const listedAfterUiDelete = textOf(await call('canvas_list'))
  check(
    uiDeleteDone && !/renamed-by-mcp/.test(listedAfterUiDelete),
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

  // 第八次：多席位联手作画、动态席位配色/筛选与 canvas_pass 递画笔
  await call('canvas_open', { board: 'collab', title: '联手作画' })
  await sleep(300)
  const client2 = new Client({ name: 'flying-draws-e2e-peer', version: '0.0.1' })
  await client2.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'out/bridge/index.js')],
      env: { ...process.env, FLYINGDRAWS_HOME: HOME, FLYINGDRAWS_DEBUG_PORT: String(DEBUG_PORT) },
      stderr: 'inherit'
    })
  )
  const call2 = (name, args = {}) => client2.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
  try {
    // 还没落笔前，先读一次画布声明席位，状态栏应该立刻显示两个在线席位
    await call('canvas_read', { board: 'collab', as: '前端', image: 'never' })
    await call2('canvas_read', { board: 'collab', as: '后端', image: 'never' })
    await sleep(250)
    const onlineBeforeDraw = await user3.js(`[...document.querySelectorAll('.fd-seat-pill .fd-seat-name')].map((s) => s.textContent.trim())`)
    check(
      onlineBeforeDraw.includes('前端') && onlineBeforeDraw.includes('后端'),
      '两个席位只需读一次画布，还没落笔也会实时出现在顶部在线席位栏'
    )

    await call('canvas_draw', { board: 'collab', as: '前端', ops: [{ op: 'add_node', id: 'h1', label: '前端草图' }] })
    const peerRead = textOf(
      await call2('canvas_draw', { board: 'collab', as: '后端', ops: [{ op: 'add_node', id: 'f1', label: '后端接口' }] })
    )
    check(
      /「前端草图」矩形【其他 agent（前端）画的】/.test(peerRead) && /「后端接口」矩形【agent 画的】/.test(peerRead),
      '两个席位画在同一画板上，互读时准确标出「其他 agent（xxx）」'
    )
    const collabDisk = JSON.parse(readFileSync(join(HOME, 'boards', 'collab.excalidraw'), 'utf8')).elements.filter((el) => !el.isDeleted)
    const hEl = collabDisk.find((el) => el.customData?.flyingdraws?.agent === '前端')
    const fEl = collabDisk.find((el) => el.customData?.flyingdraws?.agent === '后端')
    check(
      hEl?.strokeColor === '#1971c2' && fEl?.strokeColor === '#7048e8' && hEl?.customData?.flyingdraws?.seat === true,
      '两个席位自动分配不同专属颜色并写入席位标记'
    )
    await sleep(300)
    const filterTabs = await user3.js(`[...document.querySelectorAll('.fd-filter button')].map((b) => b.textContent.trim())`)
    check(
      filterTabs.includes('前端') && filterTabs.includes('后端'),
      '页面底部动态出现「前端」「后端」席位筛选按钮'
    )
    await user3.click('后端')
    await sleep(200)
    const onlyPeerVisible = await user3.js(`(() => {
      const els = window.__flyingdrawsApi.getSceneElements()
      const h = els.find((e) => e.customData?.flyingdraws?.agent === '前端')
      const f = els.find((e) => e.customData?.flyingdraws?.agent === '后端')
      return h?.opacity === 0 && h?.locked === true && f?.opacity === 100 && !f?.locked
    })()`)
    check(onlyPeerVisible === true, '点击「后端」席位标签只显示后端画的内容，隐藏前端的内容')
    await user3.click('全部')
    await sleep(200)

    // 点选席位发送：两个席位都在线时，「发给 agent」横幅里可以选发给谁
    const noticeText = () => user3.js(`document.querySelector('.fd-waiting')?.textContent ?? ''`)
    const toastText = () => user3.js(`document.querySelector('.fd-toast')?.textContent ?? ''`)
    const pickSeat = (label) =>
      user3.js(`(() => {
        const b = [...document.querySelectorAll('.fd-send-to button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)}))
        if (!b) return false
        b.click()
        return true
      })()`)
    await user3.click('发给 agent')
    await user3.waitForBanner()
    const seatChoices = await user3.js(`[...document.querySelectorAll('.fd-send-to button')].map((b) => b.textContent.trim())`)
    check(
      seatChoices[0] === '所有 agent' && seatChoices.includes('@前端') && seatChoices.includes('@后端'),
      '两个席位在线时，「发给 agent」横幅里出现「所有 agent / @前端 / @后端」'
    )
    check(await pickSeat('@后端'), '（扮演用户）点选 @后端')
    await sleep(150)
    check(/后端 现在没在等/.test((await user3.waitForBanner()) ?? ''), '点选的席位没在等时，横幅提示语换成这个席位的名字')
    await user3.screenshot(join(OUT, 'send-to.png'))
    await user3.click('发送')
    check(await until(async () => /已复制一句话，去「后端」的聊天里粘贴/.test((await toastText()) ?? '')), '发出后提示已复制一句话，并说明去谁的聊天里粘贴')
    check(await until(async () => /已发出，后端 还没来取/.test((await noticeText()) ?? '')), '画布上写明是「后端」还没来取')
    const notMine = textOf(await call('canvas_read', { board: 'collab', as: '前端', image: 'never' }))
    check(!/pressed "Send to agent"/.test(notMine) && /已发出，后端 还没来取/.test((await noticeText()) ?? ''), '另一个席位来读画布，取不走发给后端的那份')
    const mineNow = textOf(await call2('canvas_read', { board: 'collab', as: '后端', image: 'never' }))
    await sleep(200)
    check(/pressed "Send to agent"/.test(mineNow) && !(await noticeText()), '后端自己来读时取走，画布上的等待提示消失')

    // 点选的席位正在等：直接交到它手上
    const seatWaiting = call2('canvas_wait', { board: 'collab', as: '后端', timeout_s: 20, image: 'never' })
    await until(async () => /正在等你（后端）/.test((await noticeText()) ?? ''))
    await user3.click('发给 agent')
    await user3.waitForBanner()
    await pickSeat('@后端')
    await sleep(150)
    const waitingBanner = (await user3.waitForBanner()) ?? ''
    await user3.click('发送')
    const seatGot = textOf(await seatWaiting)
    check(
      /后端 正在等你的画/.test(waitingBanner) && /The user sent the canvas/.test(seatGot) && (await until(async () => /后端 已经收到你的画/.test((await toastText()) ?? ''))),
      '点选的席位正在等时：横幅说明它马上能看到，发出后直接送达并提示「后端 已经收到你的画」'
    )

    // 递画笔场景一：后端正在等待，前端直接递过去立即唤醒
    const peerWaiting = call2('canvas_wait', { board: 'collab', as: '后端', timeout_s: 20, image: 'never' })
    await until(async () => /正在等你（后端）/.test((await user3.js(`document.querySelector('.fd-waiting')?.textContent ?? ''`)) ?? ''))
    const passDirect = textOf(await call('canvas_pass', { board: 'collab', as: '前端', to: '后端', note: '前端框好了，请补接口' }))
    const peerGot = textOf(await peerWaiting)
    check(
      /directly to waiting seat "后端"/.test(passDirect) && /passed the brush to you/.test(peerGot) && /前端框好了，请补接口/.test(peerGot),
      'canvas_pass 直接唤醒正在 canvas_wait 的目标席位并送达附言与画布'
    )

    // 递画笔场景二：对方还没等，先挂在画板上再由对方 canvas_read 接手
    const passQueued = textOf(await call2('canvas_pass', { board: 'collab', as: '后端', to: '前端', note: '接口补好了，请核对' }))
    await sleep(200)
    const handoffNotice = await user3.js(`document.querySelector('.fd-waiting')?.textContent ?? ''`)
    check(
      /queued/.test(passQueued) && /后端 把画笔递给了 前端：「接口补好了，请核对」/.test(handoffNotice),
      '对方尚未等待时，canvas_pass 挂起交接并在画布顶部提示'
    )
    const readTaken = textOf(await call('canvas_read', { board: 'collab', as: '前端', image: 'never' }))
    await sleep(200)
    const handoffCleared = await user3.js(`document.querySelector('.fd-waiting')?.textContent ?? ''`)
    check(
      /Agent "后端" passed the brush to you: "接口补好了，请核对"/.test(readTaken) && !handoffCleared,
      '目标席位调用 canvas_read 时自动接走画笔并清除顶部交接提示'
    )

    // 递画笔场景三：后端的 canvas_wait 被取消（比如在客户端按了 Esc），画布要撤下这次等待；
    // 之后递来的画笔不能交给已经走掉的等待，要留在画板上，等后端下次来取
    const waitingText = () => user3.js(`document.querySelector('.fd-waiting')?.textContent ?? ''`)
    const abortWait = new AbortController()
    const cancelledWait = client2
      .callTool({ name: 'canvas_wait', arguments: { board: 'collab', as: '后端', timeout_s: 30, image: 'never' } }, undefined, { timeout: 120000, signal: abortWait.signal })
      .then(() => 'finished', () => 'aborted')
    await until(async () => /正在等你（后端）/.test((await waitingText()) ?? ''))
    abortWait.abort()
    const waitOutcome = await cancelledWait
    const waiterGone = await until(async () => !/正在等你（后端）/.test((await waitingText()) ?? ''))
    const passAfterCancel = textOf(await call('canvas_pass', { board: 'collab', as: '前端', to: '后端', note: '取消之后再递一次' }))
    const retaken = textOf(await call2('canvas_wait', { board: 'collab', as: '后端', timeout_s: 5, image: 'never' }))
    check(
      waitOutcome === 'aborted' && waiterGone && /queued/.test(passAfterCancel) && /取消之后再递一次/.test(retaken),
      'canvas_wait 被取消后画布撤下等待：之后递来的画笔留在画板上，下次等待能接到'
    )

    // 等一块不存在的画板不会无声地一直等：直接报错，并带上数据目录，方便发现连错了实例
    const missingBoard = textOf(await call2('canvas_wait', { board: 'no-such-board-e2e', as: '后端', timeout_s: 3, image: 'never' }))
    check(
      /does not exist in the canvas whose data directory is .*e2e-home/.test(missingBoard),
      'canvas_wait 等一块不存在的画板时直接报错并说明数据目录'
    )
  } finally {
    await client2.close()
  }
  await sleep(300)
  const onlineAfterPeerClose = await user3.js(`[...document.querySelectorAll('.fd-seat-pill .fd-seat-name')].map((s) => s.textContent.trim())`)
  check(!onlineAfterPeerClose.includes('后端') && onlineAfterPeerClose.includes('前端'), '第二个桥接断开后，「后端」立即从在线席位栏撤下')
  await call('canvas_delete', { board: 'collab' })
  await sleep(300)

  // 手感：画板工具在标题栏里，画布右上角只留「发给 agent」；键盘就能发送
  const layout = await user3.js(`({
    inTitlebar: Boolean(document.querySelector('.fd-titlebar .fd-board-select') && document.querySelector('.fd-titlebar .fd-more') && document.querySelector('.fd-titlebar .fd-save')),
    onCanvas: [...document.querySelectorAll('.fd-canvas .fd-status button')].map((b) => b.textContent.trim())
  })`)
  check(layout.inTitlebar && layout.onCanvas.length === 1 && layout.onCanvas[0] === '发给 agent', '画板切换、「⋯」菜单和保存状态在标题栏里，画布右上角只剩「发给 agent」')
  const pressSend = () => user3.js(`void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))`)
  const bannerOpen = () => user3.js(`Boolean(document.querySelector('.fd-banner'))`)
  await pressSend()
  check(
    (await until(bannerOpen)) && (await user3.js(`document.activeElement?.classList.contains('fd-banner-note')`)) === true,
    'Ctrl+Shift+Enter 打开「发给 agent」横幅，光标直接在附言框里'
  )
  await user3.js(`void document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
  check(await until(async () => !(await bannerOpen())), '横幅里按 Esc 取消')
  await pressSend()
  await until(bannerOpen)
  await pressSend()
  check(
    await until(async () => /已发出，agent 还没来取/.test((await user3.js(`document.querySelector('.fd-waiting')?.textContent ?? ''`)) ?? '')),
    '横幅开着时再按一次 Ctrl+Shift+Enter 直接发出'
  )
  await user3.click('复制这句话')
  check(await until(async () => /已复制，去聊天里粘贴/.test((await user3.js(`document.querySelector('.fd-toast')?.textContent ?? ''`)) ?? '')), '等待条上的「复制这句话」可以再要一次取画指令')
  await call('canvas_read', { as: '前端', image: 'never' })
  await sleep(300)

  // ---------- 元素移动（move）、长文本中心扩宽与可拖拽落点框（move-ghost） ----------
  await call('canvas_open', { board: 'move-widen', title: '移动与自动扩宽验证' })
  await until(async () => (await user3.js(`document.querySelector('.fd-board-select')?.value`)) === 'move-widen')
  const mwInit = textOf(
    await call('canvas_draw', {
      board: 'move-widen',
      ops: [
        { op: 'add_node', id: 'entry', label: '入口' },
        { op: 'add_node', id: 'auth', label: '鉴权', shape: 'diamond' },
        { op: 'add_node', id: 'done', label: '完成' },
        { op: 'add_edge', from: 'entry', to: 'auth', label: '调用' },
        { op: 'add_edge', from: 'auth', to: 'done', label: '放行' }
      ]
    })
  )
  const mwVer0 = Number(mwInit.match(/version (\d+)/)?.[1])
  const entryId0 = mwInit.match(/entry = (N\d+)/)?.[1]
  const authId0 = mwInit.match(/auth = (N\d+)/)?.[1]
  const doneId0 = mwInit.match(/done = (N\d+)/)?.[1]
  const beforeMetrics = await user3.js(`(() => {
    const els = window.__flyingdrawsApi.getSceneElements().filter((e) => !e.isDeleted)
    const byText = (t) => {
      const tx = els.find((e) => e.type === 'text' && e.text === t)
      return tx ? els.find((e) => e.id === tx.containerId) : null
    }
    const entry = byText('入口')
    const auth = byText('鉴权')
    const done = byText('完成')
    return {
      entry: { x: entry.x, y: entry.y, w: entry.width, h: entry.height, cx: entry.x + entry.width / 2, cy: entry.y + entry.height / 2 },
      auth: { w: auth.width, cx: auth.x + auth.width / 2 },
      done: { w: done.width, h: done.height }
    }
  })()`)

  const mwWidened = textOf(
    await call('canvas_draw', {
      board: 'move-widen',
      base_version: mwVer0,
      ops: [
        { op: 'update_node', id: entryId0, label: '统一身份认证与双因素会话续期网关 ServiceGatewayV2' },
        { op: 'update_node', id: authId0, label: '是否已通过多因子校验？' },
        { op: 'update_node', id: doneId0, label: '写审计日志\n发刷新令牌\n推下游事件' },
        { op: 'set_style', id: doneId0, height: 72 }
      ]
    })
  )
  const afterWidenMetrics = await user3.js(`(() => {
    const els = window.__flyingdrawsApi.getSceneElements().filter((e) => !e.isDeleted)
    const findContainer = (re) => {
      const tx = els.find((e) => e.type === 'text' && re.test(e.originalText || e.text || ''))
      return tx ? els.find((e) => e.id === tx.containerId) : null
    }
    const entry = findContainer(/ServiceGatewayV2/)
    const auth = findContainer(/多因子校验/)
    const done = findContainer(/写审计日志/)
    const callLabel = els.find((e) => e.type === 'text' && (e.originalText || e.text) === '调用')
    const callArrow = callLabel ? els.find((e) => e.id === callLabel.containerId) : null
    const arrowStartX = callArrow ? callArrow.x + callArrow.points[0][0] : 0
    const midX = callArrow ? callArrow.x + (callArrow.points[0][0] + callArrow.points[callArrow.points.length - 1][0]) / 2 : 0
    return {
      entryW: entry.width,
      entryCx: entry.x + entry.width / 2,
      entryCy: entry.y + entry.height / 2,
      entryRight: entry.x + entry.width,
      authW: auth.width,
      authCx: auth.x + auth.width / 2,
      doneH: done.height,
      arrowStartGap: arrowStartX - (entry.x + entry.width),
      labelCenterErr: Math.abs((callLabel.x + callLabel.width / 2) - midX)
    }
  })()`)
  check(
    !/Nothing was drawn/.test(mwWidened) &&
      afterWidenMetrics.entryW > beforeMetrics.entry.w + 80 &&
      Math.abs(afterWidenMetrics.entryCx - beforeMetrics.entry.cx) < 1.5 &&
      Math.abs(afterWidenMetrics.entryCy - beforeMetrics.entry.cy) < 1.5 &&
      afterWidenMetrics.authW > beforeMetrics.auth.w + 60 &&
      afterWidenMetrics.doneH === 72 &&
      Math.abs(afterWidenMetrics.arrowStartGap - 8) < 3 &&
      afterWidenMetrics.labelCenterErr < 3,
    'update_node 长文本从中心自动扩宽（矩形+菱形）、同批显式 set_style 高度不被覆盖、相连箭头与连线标签同步贴边居中'
  )

  // canvas_draw move（near + side 语义贴边 + 返回新旧阅读顺序编号对照）
  const mwVer1 = Number(mwWidened.match(/version (\d+)/)?.[1])
  const doneNow1 = mwWidened.match(/(N\d+) 「写审计日志/)?.[1]
  const entryNow1 = mwWidened.match(/(N\d+) 「统一身份认证/)?.[1]
  const mwMoved = textOf(
    await call('canvas_draw', {
      board: 'move-widen',
      base_version: mwVer1,
      ops: [{ op: 'move', id: doneNow1, near: entryNow1, side: 'below', gap: 50 }]
    })
  )
  const afterNearMove = await user3.js(`(() => {
    const els = window.__flyingdrawsApi.getSceneElements().filter((e) => !e.isDeleted)
    const findContainer = (re) => {
      const tx = els.find((e) => e.type === 'text' && re.test(e.originalText || e.text || ''))
      return tx ? els.find((e) => e.id === tx.containerId) : null
    }
    const entry = findContainer(/ServiceGatewayV2/)
    const done = findContainer(/写审计日志/)
    return {
      gapY: done.y - (entry.y + entry.height),
      centerDiffX: Math.abs((done.x + done.width / 2) - (entry.x + entry.width / 2))
    }
  })()`)
  check(
    /1 moved/.test(mwMoved) && /Moved ids:/.test(mwMoved) && Math.abs(afterNearMove.gapY - 50) < 3 && afterNearMove.centerDiffX < 3,
    'move(near + side: "below", gap: 50) 将节点精确摆到锚点正下方并输出 Moved ids 对照表'
  )

  // canvas_propose 移动提议：可拖拽落点框微调 + 待决提议目标互斥锁 + 局部删落点框否决
  const mwRead2 = textOf(await call('canvas_read', { board: 'move-widen', image: 'never' }))
  const mwVer2 = Number(mwRead2.match(/v(\d+)：/)?.[1])
  const entryNow2 = mwRead2.match(/(N\d+) 「统一身份认证/)?.[1]
  const entryBeforeProp = await user3.js(`(() => {
    const els = window.__flyingdrawsApi.getSceneElements().filter((e) => !e.isDeleted)
    const tx = els.find((e) => e.type === 'text' && /ServiceGatewayV2/.test(e.originalText || e.text || ''))
    const box = els.find((e) => e.id === tx.containerId)
    return { id: box.id, x: box.x, y: box.y }
  })()`)
  const propMoveRes = textOf(
    await call('canvas_propose', {
      board: 'move-widen',
      base_version: mwVer2,
      question: '把入口网关往右挪 200px 可以吗？',
      ops: [{ op: 'move', id: entryNow2, dx: 200, dy: 0 }]
    })
  )
  const reqMoveProp = propMoveRes.match(/req_\w+/)?.[0]
  await user3.waitForBanner()

  // 待决提议锁定检查：同一目标不能被另一条并发修改绕过
  const mwReadDuringProp = textOf(await call('canvas_read', { board: 'move-widen', image: 'never' }))
  const mwVerDuring = Number(mwReadDuringProp.match(/v(\d+)：/)?.[1])
  const entryDuringId = mwReadDuringProp.match(/(N\d+) 「统一身份认证/)?.[1]
  check(!/移到这里/.test(mwReadDuringProp), '提议挂起期间 move-ghost 落点预览框不会混入语义层节点列表')
  const blockedConcurrent = await call('canvas_draw', {
    board: 'move-widen',
    base_version: mwVerDuring,
    ops: [{ op: 'move', id: entryDuringId, dx: 40, dy: 0 }]
  })
  check(
    blockedConcurrent.isError === true && /unanswered proposal/.test(textOf(blockedConcurrent)),
    '已有未决提议锁定的元素拒绝被其他并发修改覆盖'
  )

  // 扮演用户把 move-ghost 落点框再往右下拖 (+60, +80) 后点击「对，就这样」
  const nudgedGhost = await user3.js(`(() => {
    const api = window.__flyingdrawsApi
    const all = api.getSceneElementsIncludingDeleted()
    const ghost = all.find((e) => !e.isDeleted && e.type === 'rectangle' && e.customData?.flyingdraws?.role === 'move-ghost')
    if (!ghost) return false
    api.updateScene({
      elements: all.map((e) =>
        e.id === ghost.id || e.containerId === ghost.id
          ? { ...e, x: e.x + 60, y: e.y + 80, version: e.version + 1, versionNonce: Math.floor(Math.random() * 1e9) }
          : e
      )
    })
    return true
  })()`)
  check(nudgedGhost === true, '（扮演用户）在画布上拖拽提议落点框微调 (+60, +80)')
  const waitMoveProp = call('canvas_wait', { request_id: reqMoveProp, timeout_s: 30, image: 'never' })
  await user3.click('对，就这样')
  const movePropDone = textOf(await waitMoveProp)
  const entryAfterProp = await user3.js(`(() => {
    const els = window.__flyingdrawsApi.getSceneElements().filter((e) => !e.isDeleted)
    const box = els.find((e) => e.id === ${JSON.stringify(entryBeforeProp.id)})
    const ghostsLeft = els.filter((e) => e.customData?.flyingdraws?.role === 'move-ghost' || e.customData?.flyingdraws?.role === 'marker').length
    return { x: box.x, y: box.y, ghostsLeft }
  })()`)
  check(
    /ACCEPTED/.test(movePropDone) &&
      /微调了/.test(movePropDone) &&
      Math.abs(entryAfterProp.x - (entryBeforeProp.x + 260)) < 2 &&
      Math.abs(entryAfterProp.y - (entryBeforeProp.y + 80)) < 2 &&
      entryAfterProp.ghostsLeft === 0,
    '接受移动提议后：按用户拖拽后的落点 (+260, +80) 生效、回传微调说明并清理预览框'
  )

  // 同一目标「改字 + 移动」提议中单独删掉落点框：保留改字、单独否决移动
  const mwRead3 = textOf(await call('canvas_read', { board: 'move-widen', image: 'never' }))
  const mwVer3 = Number(mwRead3.match(/v(\d+)：/)?.[1])
  const doneNow3 = mwRead3.match(/(N\d+) 「写审计日志/)?.[1]
  const doneBeforeVeto = await user3.js(`(() => {
    const els = window.__flyingdrawsApi.getSceneElements().filter((e) => !e.isDeleted)
    const tx = els.find((e) => e.type === 'text' && /写审计日志/.test(e.originalText || e.text || ''))
    const box = els.find((e) => e.id === tx.containerId)
    return { id: box.id, x: box.x, y: box.y, cx: box.x + box.width / 2, cy: box.y + box.height / 2 }
  })()`)
  const propCombo = textOf(
    await call('canvas_propose', {
      board: 'move-widen',
      base_version: mwVer3,
      question: '把完成节点改名并右移 180px？',
      ops: [
        { op: 'update_node', id: doneNow3, label: '审计归档完成' },
        { op: 'move', id: doneNow3, dx: 180, dy: 0 }
      ]
    })
  )
  const reqCombo = propCombo.match(/req_\w+/)?.[0]
  await user3.waitForBanner()
  await user3.screenshot(join(OUT, 'propose-move-ghost.png'))
  await user3.js(`(() => {
    const api = window.__flyingdrawsApi
    const all = api.getSceneElementsIncludingDeleted()
    api.updateScene({
      elements: all.map((e) =>
        e.customData?.flyingdraws?.role === 'move-ghost' ? { ...e, isDeleted: true, version: e.version + 1 } : e
      )
    })
  })()`)
  const waitCombo = call('canvas_wait', { request_id: reqCombo, timeout_s: 30, image: 'never' })
  await user3.click('对，就这样')
  const comboDone = textOf(await waitCombo)
  const doneAfterVeto = await user3.js(`(() => {
    const els = window.__flyingdrawsApi.getSceneElements().filter((e) => !e.isDeleted)
    const box = els.find((e) => e.id === ${JSON.stringify(doneBeforeVeto.id)})
    const tx = els.find((e) => e.type === 'text' && e.containerId === box.id)
    return { cx: box.x + box.width / 2, cy: box.y + box.height / 2, text: tx?.originalText || tx?.text || '' }
  })()`)
  // 改字可能触发从中心向两侧的自动扩宽，左上角会随之变化；移动被否决的判据是中心点没动
  check(
    /ACCEPTED/.test(comboDone) &&
      /不同意移动/.test(comboDone) &&
      doneAfterVeto.text === '审计归档完成' &&
      Math.abs(doneAfterVeto.cx - doneBeforeVeto.cx) < 2 &&
      Math.abs(doneAfterVeto.cy - doneBeforeVeto.cy) < 2,
    '组合提议中单独删掉 move-ghost 落点框：改字照常生效，移动被单独否决并回传给 agent'
  )
  // P4 回归 A：同批多行改字 + 绝对坐标 move(x,y) + 向下新增连线，左上角精准落在指定坐标且新箭头起点严格贴在实测底边 +8px
  const mwRead4 = textOf(await call('canvas_read', { board: 'move-widen', image: 'never' }))
  const mwVer4 = Number(mwRead4.match(/v(\d+)：/)?.[1])
  const target4 = mwRead4.match(/(N\d+) 「审计归档完成」/)?.[1]
  await call('canvas_draw', {
    board: 'move-widen',
    base_version: mwVer4,
    ops: [
      { op: 'update_node', id: target4, label: '归档\n落盘\n完成' },
      { op: 'move', id: target4, x: 300, y: 520 },
      { op: 'add_node', id: 'notify_end', label: '通知归档系统', x: 300, y: 720 },
      { op: 'add_edge', from: target4, to: 'notify_end', label: '回调' }
    ]
  })
  const reproA = await user3.js(`(() => {
    const els = window.__flyingdrawsApi.getSceneElements().filter((e) => !e.isDeleted)
    const box = els.find((e) => e.id === ${JSON.stringify(doneBeforeVeto.id)})
    const arrow = els.find((e) => e.type === 'arrow' && e.startBinding?.elementId === box.id)
    const startY = arrow.y + (arrow.points?.[0]?.[1] ?? 0)
    return { x: box.x, y: box.y, h: box.height, startY }
  })()`)
  check(
    Math.abs(reproA.x - 300) < 1.5 &&
      Math.abs(reproA.y - 520) < 1.5 &&
      Math.abs(reproA.startY - (reproA.y + reproA.h + 8)) < 2,
    '同批多行改字 + 绝对 move(x,y) + 新连线：左上角严格落在 (300, 520)，新连线起点严格贴在实测底边 +8px'
  )

  // P4 回归 B：提议里 set_style 改宽 + 新增向右连线，删掉原位标记框否决改宽后接受，新连线起点贴回原宽度右边缘 +8px
  const mwRead5 = textOf(await call('canvas_read', { board: 'move-widen', image: 'never' }))
  const mwVer5 = Number(mwRead5.match(/v(\d+)：/)?.[1])
  const notifyId = mwRead5.match(/(N\d+) 「通知归档系统」/)?.[1]
  const notifyBefore = await user3.js(`(() => {
    const els = window.__flyingdrawsApi.getSceneElements().filter((e) => !e.isDeleted)
    const tx = els.find((e) => e.type === 'text' && (e.originalText || e.text) === '通知归档系统')
    const box = els.find((e) => e.id === tx.containerId)
    return { id: box.id, x: box.x, w: box.width }
  })()`)
  const propStyleEdge = textOf(
    await call('canvas_propose', {
      board: 'move-widen',
      base_version: mwVer5,
      question: '把通知节点加宽到 280px 并连到回执节点？',
      ops: [
        { op: 'set_style', id: notifyId, width: 280 },
        { op: 'add_node', id: 'ack_box', label: '收到回执', x: 760, y: 720 },
        { op: 'add_edge', from: notifyId, to: 'ack_box' }
      ]
    })
  )
  const reqStyleEdge = propStyleEdge.match(/req_\w+/)?.[0]
  await user3.waitForBanner()
  await user3.js(`(() => {
    const api = window.__flyingdrawsApi
    const all = api.getSceneElementsIncludingDeleted()
    api.updateScene({
      elements: all.map((e) =>
        e.customData?.flyingdraws?.role === 'marker' ? { ...e, isDeleted: true, version: e.version + 1 } : e
      )
    })
  })()`)
  const waitStyleEdge = call('canvas_wait', { request_id: reqStyleEdge, timeout_s: 30, image: 'never' })
  await user3.click('对，就这样')
  const styleEdgeDone = textOf(await waitStyleEdge)
  const reproB = await user3.js(`(() => {
    const els = window.__flyingdrawsApi.getSceneElements().filter((e) => !e.isDeleted)
    const box = els.find((e) => e.id === ${JSON.stringify(notifyBefore.id)})
    const arrow = els.find((e) => e.type === 'arrow' && e.startBinding?.elementId === box.id)
    const startX = arrow.x + (arrow.points?.[0]?.[0] ?? 0)
    return { x: box.x, w: box.width, startX }
  })()`)
  check(
    /ACCEPTED/.test(styleEdgeDone) &&
      Math.abs(reproB.w - notifyBefore.w) < 1.5 &&
      Math.abs(reproB.startX - (reproB.x + reproB.w + 8)) < 2,
    '否决提议里的 set_style 改宽但接受新连线时：节点保持原宽度，新连线起点精准贴回原右边缘 +8px'
  )

  await user3.screenshot(join(OUT, 'move-widen.png'))

  // ---------- 场景 3：提议挂着时用户拖动原节点 ----------
  // 提议 move dx:200 挂起时用户拖动原节点 (+40, +40)，不动落点框，接受后仍落回落点框且文字居中、箭头贴边
  const s3Read = textOf(await call('canvas_read', { board: 'move-widen', image: 'never' }))
  const s3Ver = Number(s3Read.match(/v(\d+)：/)?.[1])
  const s3TargetId = s3Read.match(/(N\d+) 「归档[\s\S]*?完成」/)?.[1]
  const s3Before = await user3.js(`(() => {
    const els = window.__flyingdrawsApi.getSceneElements().filter((e) => !e.isDeleted)
    const tx = els.find((e) => e.type === 'text' && /归档[\\s\\S]*完成/.test(e.originalText || e.text || ''))
    const box = tx ? els.find((e) => e.id === tx.containerId) : null
    return box ? { id: box.id, x: box.x, y: box.y, w: box.width, h: box.height } : null
  })()`)
  const s3Prop = textOf(
    await call('canvas_propose', {
      board: 'move-widen',
      base_version: s3Ver,
      question: '把归档完成节点右移 200px？',
      ops: [{ op: 'move', id: s3TargetId, dx: 200, dy: 0 }]
    })
  )
  const s3Req = s3Prop.match(/req_\w+/)?.[0]
  await user3.waitForBanner()
  const s3Ghost = await user3.js(`(() => {
    const api = window.__flyingdrawsApi
    const all = api.getSceneElementsIncludingDeleted()
    const ghost = all.find((e) => !e.isDeleted && e.type === 'rectangle' && e.customData?.flyingdraws?.role === 'move-ghost')
    if (!ghost) return null
    const bump = (e) => ({ ...e, x: e.x + 40, y: e.y + 40, version: e.version + 1, versionNonce: Math.floor(Math.random() * 1e9) })
    api.updateScene({
      elements: all.map((e) => (e.id === ${JSON.stringify(s3Before?.id ?? null)} || e.containerId === ${JSON.stringify(s3Before?.id ?? null)} ? bump(e) : e))
    })
    return { x: ghost.x, y: ghost.y }
  })()`)
  check(Boolean(s3Ghost), '场景 3 前置：（扮演用户）提议挂起时将原节点连同绑定文字拖动 (+40, +40)，保持落点框不动')
  const s3Wait = call('canvas_wait', { request_id: s3Req, timeout_s: 30, image: 'never' })
  await user3.click('对，就这样')
  const s3Done = textOf(await s3Wait)
  const s3After = await user3.js(`(() => {
    const els = window.__flyingdrawsApi.getSceneElements().filter((e) => !e.isDeleted)
    const box = els.find((e) => e.id === ${JSON.stringify(s3Before?.id ?? null)})
    if (!box) return null
    const tx = els.find((e) => e.type === 'text' && e.containerId === box.id)
    const distToRect = (px, py, b) => Math.hypot(Math.max(b.x - px, 0, px - (b.x + b.width)), Math.max(b.y - py, 0, py - (b.y + b.height)))
    const arrowDists = els
      .filter((e) => e.type === 'arrow' && (e.startBinding?.elementId === box.id || e.endBinding?.elementId === box.id))
      .map((a) => {
        const pts = a.points && a.points.length >= 2 ? a.points : [[0, 0], [a.width, a.height]]
        const [p, q] = [pts[0], pts[pts.length - 1]]
        const endPt = a.startBinding?.elementId === box.id ? [a.x + p[0], a.y + p[1]] : [a.x + q[0], a.y + q[1]]
        return distToRect(endPt[0], endPt[1], box)
      })
    return {
      x: box.x,
      y: box.y,
      textCxDiff: tx ? Math.abs((tx.x + tx.width / 2) - (box.x + box.width / 2)) : Infinity,
      textCyDiff: tx ? Math.abs((tx.y + tx.height / 2) - (box.y + box.height / 2)) : Infinity,
      arrowDists
    }
  })()`)
  check(
    /ACCEPTED/.test(s3Done) &&
      !/微调了/.test(s3Done) &&
      Boolean(s3Ghost && s3After) &&
      Math.abs(s3After.x - s3Ghost.x) < 2 &&
      Math.abs(s3After.y - s3Ghost.y) < 2 &&
      s3After.textCxDiff < 2 &&
      s3After.textCyDiff < 2 &&
      s3After.arrowDists.length > 0 &&
      s3After.arrowDists.every((d) => d > 0 && d <= 12),
    '场景 3：拖动原节点后接受提议，节点落回落点框 toBbox、绑定文字居中、相连箭头贴着节点轮廓（<= 12px）'
  )

  await call('canvas_delete', { board: 'move-widen' })

  // ---------- 场景 1：旧短号带空白（id: " N1 "） ----------
  await call('canvas_open', { board: 'id-trim-test', title: '短号空白归一化验证' })
  await until(async () => (await user3.js(`document.querySelector('.fd-board-select')?.value`)) === 'id-trim-test')
  const trimInit = textOf(
    await call('canvas_draw', {
      board: 'id-trim-test',
      ops: [
        { op: 'add_node', id: 'target', label: '目标节点', x: 400, y: 200 },
        { op: 'add_node', id: 'bystander', label: '旁观节点', x: 700, y: 200 }
      ]
    })
  )
  const trimVer0 = Number(trimInit.match(/version (\d+)/)?.[1])
  const oldTargetShortId = trimInit.match(/target = (N\d+)/)?.[1]
  check(oldTargetShortId === 'N1', `场景 1 前置：初始目标节点短号为 ${oldTargetShortId}`)

  // 在前面插入一个节点，挤掉旧 N1 的阅读顺序位置：现在 N1=前置节点，N2=目标节点，N3=旁观节点
  await call('canvas_draw', {
    board: 'id-trim-test',
    ops: [{ op: 'add_node', id: 'front', label: '前置节点', x: 100, y: 100 }]
  })
  const trimReadShift = textOf(await call('canvas_read', { board: 'id-trim-test', image: 'never' }))
  check(
    /N1 「前置节点」/.test(trimReadShift) && /N2 「目标节点」/.test(trimReadShift) && /N3 「旁观节点」/.test(trimReadShift),
    '场景 1 前置：插入前置节点后，原 N1 已重排为 N2'
  )

  const snapNodes = () =>
    user3.js(`(() => {
      const els = window.__flyingdrawsApi.getSceneElements().filter((e) => !e.isDeleted)
      const pick = (re) => {
        const tx = els.find((e) => e.type === 'text' && re.test(e.originalText || e.text || ''))
        const box = tx ? els.find((e) => e.id === tx.containerId) : null
        return box ? { id: box.id, x: box.x, y: box.y, w: box.width, h: box.height, cx: box.x + box.width / 2, cy: box.y + box.height / 2, ver: box.version, text: tx.originalText || tx.text, textVer: tx.version } : null
      }
      return { front: pick(/^前置节点$/), target: pick(/^目标/), bystander: pick(/^旁观节点$/) }
    })()`)
  const beforeTrim = await snapNodes()

  // 用旧版本 + 带首尾空格的 " N1 " 调 move 和 update_node，必须命中原目标节点（现 N2），绝不改到现 N1（前置节点）或旁观节点
  const paddedOldId = ` ${oldTargetShortId} `
  const trimMoveUpdateRes = await call('canvas_draw', {
    board: 'id-trim-test',
    base_version: trimVer0,
    ops: [
      { op: 'move', id: paddedOldId, dx: 80, dy: 60 },
      { op: 'update_node', id: paddedOldId, label: '目标已改' }
    ]
  })
  const trimMoveUpdateText = textOf(trimMoveUpdateRes)
  const afterTrim = await snapNodes()
  check(
    !trimMoveUpdateRes.isError &&
      afterTrim.target?.text === '目标已改' &&
      Math.abs(afterTrim.target.cx - (beforeTrim.target.cx + 80)) < 2 &&
      Math.abs(afterTrim.target.cy - (beforeTrim.target.cy + 60)) < 2 &&
      afterTrim.front?.x === beforeTrim.front?.x &&
      afterTrim.front?.y === beforeTrim.front?.y &&
      afterTrim.front?.w === beforeTrim.front?.w &&
      afterTrim.front?.h === beforeTrim.front?.h &&
      afterTrim.front?.ver === beforeTrim.front?.ver &&
      afterTrim.front?.text === '前置节点' &&
      afterTrim.front?.textVer === beforeTrim.front?.textVer &&
      afterTrim.bystander?.x === beforeTrim.bystander?.x &&
      afterTrim.bystander?.y === beforeTrim.bystander?.y &&
      afterTrim.bystander?.ver === beforeTrim.bystander?.ver &&
      afterTrim.bystander?.text === '旁观节点',
    '场景 1：旧短号带首尾空白 " N1 " 调 move+update_node：准确作用到原目标节点，现 N1（前置节点）与旁观节点完全未改'
  )

  // 同版本下 update_node 带空白（不经过 rebaseOps、直达 planOps）+ 纯空白应返回 invalid 且不改画布
  const trimVer2 = Number(trimMoveUpdateText.match(/version (\d+)/)?.[1])
  const sameVerUpdateRes = await call('canvas_draw', {
    board: 'id-trim-test',
    base_version: trimVer2,
    ops: [{ op: 'update_node', id: ' N1 ', label: '前置已改' }]
  })
  const afterSameVer = await user3.js(`(() => {
    const els = window.__flyingdrawsApi.getSceneElements().filter((e) => !e.isDeleted)
    const tx = els.find((e) => e.type === 'text' && (e.originalText || e.text) === '前置已改')
    const tgtTx = els.find((e) => e.type === 'text' && (e.originalText || e.text) === '目标已改')
    const tgtBox = tgtTx ? els.find((e) => e.id === tgtTx.containerId) : null
    return { frontRenamed: Boolean(tx), targetVer: tgtBox?.version }
  })()`)
  check(
    !sameVerUpdateRes.isError && afterSameVer.frontRenamed && afterSameVer.targetVer === afterTrim.target?.ver,
    '场景 1：同版本 update_node 带首尾空白 " N1 " 经 planOps trim 命中现 N1，不改其他节点'
  )

  const trimVer3 = Number(textOf(sameVerUpdateRes).match(/version (\d+)/)?.[1])
  const blankIdRes = await call('canvas_draw', {
    board: 'id-trim-test',
    base_version: trimVer3,
    ops: [{ op: 'update_node', id: '   ', label: '不应生效' }]
  })
  const blankMoveRes = await call('canvas_draw', {
    board: 'id-trim-test',
    base_version: trimVer3,
    ops: [{ op: 'move', id: '   ', dx: 50, dy: 0 }]
  })
  const hasInvalidNode = await user3.js(`window.__flyingdrawsApi.getSceneElements().some((e) => !e.isDeleted && e.type === 'text' && (e.originalText || e.text) === '不应生效')`)
  check(
    blankIdRes.isError === true && /Nothing was drawn/.test(textOf(blankIdRes)) && blankMoveRes.isError === true && !hasInvalidNode,
    '场景 1：纯空白 id 调 update_node / move 返回明确报错且不改动任何节点'
  )
  await call('canvas_delete', { board: 'id-trim-test' })

  // ---------- 场景 2：手绘组读取后少一笔（move S* 冲突与原子性） ----------
  await call('canvas_open', { board: 'stroke-conflict', title: '手绘组冲突验证' })
  await until(async () => (await user3.js(`document.querySelector('.fd-board-select')?.value`)) === 'stroke-conflict')
  const injectedStrokes = await user3.js(`(() => {
    const api = window.__flyingdrawsApi
    const now = Date.now()
    const mkStroke = (id, x, y, seed) => ({
      id,
      type: 'freedraw',
      x,
      y,
      width: 30,
      height: 24,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      roundness: null,
      seed,
      version: 1,
      versionNonce: Math.floor(Math.random() * 1e9),
      index: null,
      isDeleted: false,
      groupIds: [],
      frameId: null,
      boundElements: null,
      updated: now,
      link: null,
      locked: false,
      points: [[0, 0], [10, 18], [20, 6], [30, 24]],
      pressures: [0.5, 0.5, 0.5, 0.5],
      simulatePressure: true,
      lastCommittedPoint: [30, 24]
    })
    const all = api.getSceneElementsIncludingDeleted()
    api.updateScene({
      elements: [
        ...all,
        mkStroke('user_fd_1', 200, 200, 1001),
        mkStroke('user_fd_2', 225, 200, 1002),
        mkStroke('user_fd_3', 250, 200, 1003)
      ]
    })
    return true
  })()`)
  check(injectedStrokes === true, '场景 2 前置：（扮演用户）向画布写入 3 笔挨在一起的 freedraw')

  const strokeRead0 = textOf(await call('canvas_read', { board: 'stroke-conflict', image: 'never' }))
  const strokeVer0 = Number(strokeRead0.match(/v(\d+)：/)?.[1])
  const strokeGroupId = strokeRead0.match(/(S\d+) 一组手写或涂鸦（3 笔）/)?.[1]
  check(Boolean(strokeGroupId) && strokeVer0 > 0, `场景 2 前置：读画布确认 3 笔手绘被归为一组 ${strokeGroupId}（v${strokeVer0}）`)

  // 扮演用户删掉中间一笔 user_fd_2；剩下 user_fd_1 和 user_fd_3 仍聚成 S1（2 笔）
  await user3.js(`(() => {
    const api = window.__flyingdrawsApi
    const all = api.getSceneElementsIncludingDeleted()
    api.updateScene({
      elements: all.map((e) =>
        e.id === 'user_fd_2'
          ? { ...e, isDeleted: true, version: e.version + 1, versionNonce: Math.floor(Math.random() * 1e9), updated: Date.now() }
          : e
      )
    })
  })()`)
  const beforeMoveStrokes = await user3.js(`(() => {
    const els = window.__flyingdrawsApi.getSceneElements().filter((e) => !e.isDeleted && e.type === 'freedraw')
    return els.map((e) => ({ id: e.id, x: e.x, y: e.y, ver: e.version })).sort((a, b) => a.id.localeCompare(b.id))
  })()`)
  check(
    beforeMoveStrokes.length === 2 && beforeMoveStrokes[0].id === 'user_fd_1' && beforeMoveStrokes[1].id === 'user_fd_3',
    '场景 2 前置：删掉中间一笔后画布上剩余 2 笔手绘'
  )

  // 用旧 base_version 移动 S*（drawOps 内部会先 takeSnapshot + acceptScene 落盘后再检查冲突）
  const staleStrokeMove = await call('canvas_draw', {
    board: 'stroke-conflict',
    base_version: strokeVer0,
    ops: [{ op: 'move', id: strokeGroupId, dx: 120, dy: 80 }]
  })
  const staleStrokeMoveText = textOf(staleStrokeMove)
  const afterMoveStrokes = await user3.js(`(() => {
    const els = window.__flyingdrawsApi.getSceneElements().filter((e) => !e.isDeleted && e.type === 'freedraw')
    return els.map((e) => ({ id: e.id, x: e.x, y: e.y, ver: e.version })).sort((a, b) => a.id.localeCompare(b.id))
  })()`)
  const strokeDiskPath = join(HOME, 'boards', 'stroke-conflict.excalidraw')
  const diskStrokes = existsSync(strokeDiskPath)
    ? JSON.parse(readFileSync(strokeDiskPath, 'utf8'))
        .elements.filter((e) => !e.isDeleted && e.type === 'freedraw')
        .map((e) => ({ id: e.id, x: e.x, y: e.y }))
        .sort((a, b) => a.id.localeCompare(b.id))
    : null

  check(
    staleStrokeMove.isError === true &&
      /conflict/.test(staleStrokeMoveText) &&
      /deleted or changed/.test(staleStrokeMoveText) &&
      /2 笔/.test(staleStrokeMoveText) &&
      JSON.stringify(afterMoveStrokes) === JSON.stringify(beforeMoveStrokes) &&
      JSON.stringify(diskStrokes) ===
        JSON.stringify([
          { id: 'user_fd_1', x: 200, y: 200 },
          { id: 'user_fd_3', x: 250, y: 200 }
        ]),
    `场景 2：手绘组 ${strokeGroupId} 读取后少一笔再用旧 base_version move：返回 conflict，画布与落盘文件中剩下两笔坐标和 version 均完全不变`
  )
  await call('canvas_delete', { board: 'stroke-conflict' })

  // ---------- 场景 4：提议预览的反向绑定清理 ----------
  await call('canvas_open', { board: 'propose-cleanup', title: '提议反向绑定清理验证' })
  await until(async () => (await user3.js(`document.querySelector('.fd-board-select')?.value`)) === 'propose-cleanup')
  const pcInit = textOf(await call('canvas_draw', { board: 'propose-cleanup', ops: [{ op: 'add_node', id: 'base', label: '已有节点' }] }))
  const pcVer0 = Number(pcInit.match(/version (\d+)/)?.[1])
  const hostShort0 = pcInit.match(/base = (N\d+)/)?.[1]
  const hostElId = await user3.js(`(() => {
    const els = window.__flyingdrawsApi.getSceneElements().filter((e) => !e.isDeleted)
    const tx = els.find((e) => e.type === 'text' && (e.originalText || e.text) === '已有节点')
    return tx ? (els.find((e) => e.id === tx.containerId)?.id ?? null) : null
  })()`)

  // (a) 拒绝提议后，已有节点的 boundElements 不再含提议连线 id
  const propRejectRes = textOf(
    await call('canvas_propose', {
      board: 'propose-cleanup',
      base_version: pcVer0,
      question: '新增节点并连线（用于测试拒绝清理）？',
      ops: [
        { op: 'add_node', id: 'tmp_a', label: '临时节点A' },
        { op: 'add_edge', from: hostShort0, to: 'tmp_a' }
      ]
    })
  )
  const reqReject = propRejectRes.match(/req_\w+/)?.[0]
  await user3.waitForBanner()
  const previewArrowId = await user3.js(`(() => {
    const els = window.__flyingdrawsApi.getSceneElements().filter((e) => !e.isDeleted)
    const arr = els.find((e) => e.type === 'arrow' && e.customData?.flyingdraws?.layer === 'proposal')
    return arr?.id ?? null
  })()`)
  const hasPreviewBound = await user3.js(`(() => {
    const host = window.__flyingdrawsApi.getSceneElements().find((e) => e.id === ${JSON.stringify(hostElId)})
    return Boolean(host?.boundElements?.some((b) => b.id === ${JSON.stringify(previewArrowId)}))
  })()`)
  check(Boolean(previewArrowId) && hasPreviewBound === true, '场景 4(a) 前置：提议挂起时已有节点 boundElements 已挂上提议连线 id')
  const waitReject = call('canvas_wait', { request_id: reqReject, timeout_s: 30, image: 'never' })
  await user3.click('不对，去掉')
  const rejectDone = textOf(await waitReject)
  const afterRejectBound = await user3.js(`(() => {
    const host = window.__flyingdrawsApi.getSceneElements().find((e) => e.id === ${JSON.stringify(hostElId)} && !e.isDeleted)
    return (host?.boundElements ?? []).map((b) => b.id)
  })()`)
  check(
    /REJECTED/.test(rejectDone) && !afterRejectBound.includes(previewArrowId),
    '场景 4(a)：点「不对，去掉」后，已有节点 boundElements 不再包含提议连线 id'
  )

  // (b) 再提一次，仅删提议里的新节点、保留提议连线后接受：endBinding 必须为 null，boundElements 不含已删元素
  const pcRead1 = textOf(await call('canvas_read', { board: 'propose-cleanup', image: 'never' }))
  const pcVer1 = Number(pcRead1.match(/v(\d+)：/)?.[1])
  const hostShort1 = pcRead1.match(/(N\d+) 「已有节点」/)?.[1]
  const propHalfRes = textOf(
    await call('canvas_propose', {
      board: 'propose-cleanup',
      base_version: pcVer1,
      question: '再提一次（用于测试删掉新节点后接受）？',
      ops: [
        { op: 'add_node', id: 'tmp_b', label: '临时节点B' },
        { op: 'add_edge', from: hostShort1, to: 'tmp_b' }
      ]
    })
  )
  const reqHalf = propHalfRes.match(/req_\w+/)?.[0]
  await user3.waitForBanner()
  const halfDeletedIds = await user3.js(`(() => {
    const api = window.__flyingdrawsApi
    const all = api.getSceneElementsIncludingDeleted()
    const propEdge = all.find((e) => !e.isDeleted && e.type === 'arrow' && e.customData?.flyingdraws?.layer === 'proposal')
    const propNodeId = propEdge?.endBinding?.elementId
    if (!propEdge || !propNodeId) return null
    api.updateScene({
      elements: all.map((e) =>
        e.id === propNodeId || e.containerId === propNodeId ? { ...e, isDeleted: true, version: e.version + 1 } : e
      )
    })
    return { edgeId: propEdge.id, deletedNodeId: propNodeId }
  })()`)
  check(Boolean(halfDeletedIds), '场景 4(b) 前置：（扮演用户）只删掉提议新节点并保留提议连线')
  const waitHalf = call('canvas_wait', { request_id: reqHalf, timeout_s: 30, image: 'never' })
  await user3.click('对，就这样')
  const halfDone = textOf(await waitHalf)
  const afterHalfCheck = await user3.js(`(() => {
    const all = window.__flyingdrawsApi.getSceneElementsIncludingDeleted()
    const deletedSet = new Set(all.filter((e) => e.isDeleted).map((e) => e.id))
    const edge = all.find((e) => e.id === ${JSON.stringify(halfDeletedIds?.edgeId ?? null)} && !e.isDeleted)
    const host = all.find((e) => e.id === ${JSON.stringify(hostElId)} && !e.isDeleted)
    return {
      edgeAlive: Boolean(edge),
      edgeLayer: edge?.customData?.flyingdraws?.layer ?? null,
      startBindingId: edge?.startBinding?.elementId ?? null,
      endBinding: edge?.endBinding,
      hostBoundHasDeleted: (host?.boundElements ?? []).some((b) => deletedSet.has(b.id))
    }
  })()`)
  const halfOk =
    /ACCEPTED/.test(halfDone) &&
    afterHalfCheck.edgeAlive === true &&
    afterHalfCheck.edgeLayer === 'final' &&
    afterHalfCheck.startBindingId === hostElId &&
    afterHalfCheck.endBinding === null &&
    afterHalfCheck.hostBoundHasDeleted === false
  if (!halfOk) console.log('[场景 4(b) 实测]', JSON.stringify(afterHalfCheck))
  check(
    halfOk,
    '场景 4(b)：只删新节点保留连线并接受后，存活连线 endBinding 为 null 且已有节点 boundElements 不含已删元素'
  )
  await call('canvas_delete', { board: 'propose-cleanup' })

  await call('canvas_open', { board: 'default' })
  await until(async () => (await user3.js(`document.querySelector('.fd-board-select')?.value`)) === 'default')

  // 界面截图：浅色和深色各一张，菜单开着
  await user3.screenshot(join(OUT, 'ui-menu.png'))
  await user3.js(`window.__flyingdrawsApi.updateScene({ appState: { theme: 'dark' } })`)
  await sleep(300)
  await user3.click('发给 agent')
  await sleep(200)
  await openMenu()
  await user3.screenshot(join(OUT, 'ui-dark.png'))
  check((await user3.js(`document.documentElement.dataset.fdTheme`)) === 'dark', '切到深色后，横幅和菜单跟着变深色')
  await user3.click('取消')
  await user3.js(`window.__flyingdrawsApi.updateScene({ appState: { theme: 'light' } })`)
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
