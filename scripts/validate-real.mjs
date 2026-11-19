// 真实任务驱动：扮演用户操作一个隔离的 Flying draws 实例（放截图、画圈、发任务、审批、核对）。
// 每次连一下页面的 CDP，做完就退出。实例由 launch 在后台常驻，不要对用户的 ~/.flyingdraws 使用。
//
// 预算是按隔离 home 里的 cache-log 事后估算的：开新一轮前若估算已达上限就拒绝；
// 轮次进行中估算到达上限才 cancel。这不是请求发出前的硬闸，也拦不住单次调用本身的花费。
//
// 用法（参数也可放在命令后面；对应环境变量写在括号里）：
//   node scripts/validate-real.mjs [参数] <命令> [命令参数...]
//   --home       隔离数据目录（FLYINGDRAWS_VALIDATE_HOME，默认 out/validate-home，相对仓库根）
//   --page-port  页面 remote-debugging 端口（FLYINGDRAWS_VALIDATE_PAGE_PORT，默认 9351）
//   --main-port  主进程 --inspect 端口（FLYINGDRAWS_VALIDATE_MAIN_PORT，默认 9352）
//   --budget     估算费用上限，元（FLYINGDRAWS_VALIDATE_BUDGET，默认 5）
//   --price-hit  缓存命中单价，元/百万 token（FLYINGDRAWS_VALIDATE_PRICE_HIT，默认 0.04）
//   --price-miss 未命中单价（FLYINGDRAWS_VALIDATE_PRICE_MISS，默认 2）
//   --price-out  输出单价（FLYINGDRAWS_VALIDATE_PRICE_OUT，默认 8）
//   --log        驱动日志（FLYINGDRAWS_VALIDATE_LOG，默认 out/validate-evidence/log.jsonl）
//
// 默认单价是先前 deepseek-flash 高峰价，换模型时要改。launch 会设置 FLYINGDRAWS_HOME 和
// FLYINGDRAWS_DEBUG_PORT，并加上 FLYINGDRAWS_TEST_HIDDEN=1（窗口不显示）。若环境里已有
// FLYINGDRAWS_E2E_APP，则启动那个打包好的 exe，否则启动本仓库的 Electron。
//
// 命令：help、launch、workspace、state、js、click、place、loop、select、images、goal、
// run、watch、save-image、shot、review、spent。help / spent 不连接实例。
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const KNOWN_FLAGS = new Set(['home', 'page-port', 'main-port', 'budget', 'price-hit', 'price-miss', 'price-out', 'log'])
const COMMANDS = ['help', 'launch', 'workspace', 'state', 'js', 'click', 'place', 'loop', 'select', 'images', 'goal', 'run', 'watch', 'save-image', 'shot', 'review', 'spent']
const NEEDS_PAGE = new Set(['state', 'js', 'click', 'place', 'loop', 'select', 'images', 'goal', 'run', 'watch', 'save-image', 'shot', 'review'])

function usage() {
  console.log(`用法：node scripts/validate-real.mjs [参数] <命令> [命令参数...]
命令：${COMMANDS.join('、')}
参数：--home --page-port --main-port --budget --price-hit --price-miss --price-out --log
预算按 cache-log 事后估算，超了才停，不是调用前的硬闸。详情见脚本开头注释。`)
}

const raw = process.argv.slice(2)
if (raw.includes('--help') || raw.includes('-h')) {
  usage()
  process.exit(0)
}
const flags = {}
const positionals = []
for (let i = 0; i < raw.length; i++) {
  const token = raw[i]
  if (token.startsWith('--')) {
    const value = raw[++i]
    if (value === undefined || value.startsWith('--')) throw new Error(`缺少 ${token} 的值`)
    flags[token.slice(2)] = value
  } else positionals.push(token)
}
for (const key of Object.keys(flags)) {
  if (!KNOWN_FLAGS.has(key)) throw new Error(`未知参数 --${key}`)
}
const pick = (flag, envName, fallback) => flags[flag] ?? (process.env[envName] || fallback)
const number = (value, name) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} 不是有效的非负数字：${value}`)
  return n
}
const portOf = (value, name) => {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} 不是有效端口：${value}`)
  return n
}

const HOME = resolve(root, pick('home', 'FLYINGDRAWS_VALIDATE_HOME', join('out', 'validate-home')))
const PAGE_PORT = portOf(pick('page-port', 'FLYINGDRAWS_VALIDATE_PAGE_PORT', '9351'), '页面端口')
const MAIN_PORT = portOf(pick('main-port', 'FLYINGDRAWS_VALIDATE_MAIN_PORT', '9352'), '主进程端口')
const BUDGET = number(pick('budget', 'FLYINGDRAWS_VALIDATE_BUDGET', '5'), '预算')
const PRICE = {
  hit: number(pick('price-hit', 'FLYINGDRAWS_VALIDATE_PRICE_HIT', '0.04'), '命中单价'),
  miss: number(pick('price-miss', 'FLYINGDRAWS_VALIDATE_PRICE_MISS', '2'), '未命中单价'),
  out: number(pick('price-out', 'FLYINGDRAWS_VALIDATE_PRICE_OUT', '8'), '输出单价')
}
const LOG = resolve(root, pick('log', 'FLYINGDRAWS_VALIDATE_LOG', join('out', 'validate-evidence', 'log.jsonl')))
if (PAGE_PORT === MAIN_PORT) throw new Error('页面端口和主进程端口不能相同')

const log = entry => {
  mkdirSync(dirname(LOG), { recursive: true })
  appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n')
}

async function connect(port, pickTarget) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const target = list.find(pickTarget)
  if (!target) throw new Error(`端口 ${port} 上找不到目标`)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveOpen, reject) => { ws.addEventListener('open', resolveOpen); ws.addEventListener('error', reject) })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const js = async expr => {
    const reply = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description || '执行失败')
    return reply.result?.result?.value
  }
  return { ws, send, js, close: () => ws.close() }
}
const page = () => connect(PAGE_PORT, t => t.type === 'page' && t.url.startsWith('file:'))

/** 所有会话的调用记录累计费用（元，事后估算）与调用次数 */
export function spent() {
  let cost = 0, calls = 0, hit = 0, input = 0
  const sessions = join(HOME, 'agent', 'sessions')
  if (!existsSync(sessions)) return { cost, calls, hitRate: 0 }
  for (const a of readdirSync(sessions)) for (const s of readdirSync(join(sessions, a))) {
    const f = join(sessions, a, s, 'cache-log.jsonl')
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line)
      const read = r.cacheRead ?? 0
      cost += (read * PRICE.hit + Math.max(0, r.input - read) * PRICE.miss + r.output * PRICE.out) / 1e6
      calls++; hit += read; input += r.input
    }
  }
  return { cost, calls, hitRate: input ? hit / input : 0 }
}

const DANGER = /git\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--|branch\s+-D|stash\s+(drop|clear))|rm\s+-[a-z]*r|Remove-Item\s+.*-Recurse|del\s+\/s|rmdir\s+\/s|format\s+[a-z]:|npm\s+publish|curl[^|]*\|\s*(sh|bash)|Invoke-Expression|iex\s/i

const base = (id, type, x, y, w, h, extra = {}) => ({
  id, type, x, y, width: w, height: h, angle: 0, strokeColor: '#e03131', backgroundColor: 'transparent', fillStyle: 'solid',
  strokeWidth: 3, strokeStyle: 'solid', roughness: 1, opacity: 100, roundness: null, seed: Math.floor(Math.random() * 1e9),
  version: 1, versionNonce: Math.floor(Math.random() * 1e9), index: null, isDeleted: false, groupIds: [], frameId: null,
  boundElements: null, updated: Date.now(), link: null, locked: false, ...extra
})

function assertFree(port) {
  return new Promise((resolveFree, reject) => {
    const server = createServer()
    server.once('error', () => reject(new Error(`端口 ${port} 已被占用`)))
    server.listen(port, '127.0.0.1', () => server.close(resolveFree))
  })
}

async function launch() {
  await assertFree(PAGE_PORT)
  await assertFree(MAIN_PORT)
  const packaged = process.env.FLYINGDRAWS_E2E_APP
  const electron = packaged || join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  if (!existsSync(electron)) throw new Error(`找不到 Electron：${electron}`)
  mkdirSync(HOME, { recursive: true })
  const appHome = relative(root, HOME)
  const homeForApp = appHome && !appHome.startsWith('..') && !isAbsolute(appHome) ? appHome : HOME
  const env = {
    ...process.env,
    FLYINGDRAWS_HOME: homeForApp,
    FLYINGDRAWS_DEBUG_PORT: String(PAGE_PORT),
    FLYINGDRAWS_TEST_HIDDEN: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  const args = [`--inspect=127.0.0.1:${MAIN_PORT}`]
  if (!packaged) args.push(root)
  const child = spawn(electron, args, {
    cwd: root,
    env,
    windowsHide: true,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let diagnostics = ''
  let launchError
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4000) })
  child.once('error', error => { launchError = error })
  const stop = () => {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else child.kill()
  }
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (launchError || child.exitCode !== null) throw new Error(`应用启动失败：${launchError?.message || child.exitCode}\n${diagnostics}`)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PAGE_PORT}/json`)).json()
      if (list.some(t => t.type === 'page')) {
        child.stderr.destroy()
        child.unref()
        console.log(JSON.stringify({ pid: child.pid, home: homeForApp, pagePort: PAGE_PORT, mainPort: MAIN_PORT, hidden: true }))
        return
      }
    } catch {}
    await sleep(200)
  }
  stop()
  throw new Error(`等待页面调试端口超时\n${diagnostics}`)
}

const [cmd, ...args] = positionals
if (!cmd || cmd === 'help') {
  usage()
  process.exit(0)
}
if (!COMMANDS.includes(cmd)) {
  console.log('未知命令', cmd)
  usage()
  process.exit(1)
}

let p = null
try {
  if (NEEDS_PAGE.has(cmd)) p = await page()
  switch (cmd) {
    case 'launch':
      await launch()
      break
    case 'workspace': {
      // 在主进程里把「选择文件夹」对话框换成直接返回给定目录，再从页面触发选择
      const main = await connect(MAIN_PORT, () => true)
      const dir = args[0]
      await main.js(`(() => { const { dialog } = process.mainModule.require('electron'); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(dir)}] }); return true })()`)
      main.close()
      const q = await page()
      console.log(await q.js(`window.flyingdraws.agent.chooseWorkspace('default')`))
      console.log('workspace =', (await q.js('window.flyingdraws.agent.state()')).workspace)
      q.close()
      break
    }
    case 'state': {
      const s = await p.js('window.flyingdraws.agent.state()')
      const item = s.items.find(i => i.id === s.activeItemId)
      console.log(JSON.stringify({ connection: s.connection, busy: s.busy, setupNeeded: s.setupNeeded, vision: s.vision, model: s.model, workspace: s.workspace, approvalMode: s.approvalMode, error: s.error, item: item && { id: item.id, title: item.title, runs: item.runs.map(r => ({ id: r.id, status: r.status, tools: r.tools.length, approvals: r.approvals.length, images: r.images?.length ?? 0, compare: r.compareImageId, changed: r.roundChanges?.files.map(f => f.path), warning: r.verificationWarning })) } }, null, 1))
      break
    }
    case 'js': console.log(JSON.stringify(await p.js(args.join(' ')), null, 1)); break
    case 'click': {
      const label = args.join(' ')
      const ok = await p.js(`(() => { const b=[...document.querySelectorAll('button')].find(b=>!b.disabled&&b.textContent.trim().startsWith(${JSON.stringify(label)})); if(!b) return false; b.click(); return true })()`)
      console.log(ok ? `点了「${label}」` : `没找到可点的「${label}」`)
      break
    }
    case 'place': {
      // place <png> <x> <y> [scale]：把图片放到画布，返回元素 id
      const [file, x, y, scale = '0.5'] = args
      const data = readFileSync(file).toString('base64')
      const w = data && readFileSync(file).readUInt32BE(16), h = readFileSync(file).readUInt32BE(20)
      const id = `user_img_${Date.now()}`
      const fileId = `file_${Date.now()}`
      const el = base(id, 'image', Number(x), Number(y), w * Number(scale), h * Number(scale), { strokeColor: 'transparent', strokeWidth: 1, status: 'saved', fileId, scale: [1, 1], crop: null })
      await p.js(`(() => { const api=window.__flyingdrawsApi; api.addFiles([{ id: ${JSON.stringify(fileId)}, dataURL: 'data:image/png;base64,${data}', mimeType: 'image/png', created: Date.now() }]); api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ${JSON.stringify(el)}] }); })()`)
      console.log(JSON.stringify({ id, x: Number(x), y: Number(y), w: w * Number(scale), h: h * Number(scale), natural: [w, h] }))
      break
    }
    case 'loop': {
      // loop <imageElementId> <px> <py> <pw> <ph>：在图上按原图像素画一个手绘圈（略大于框），返回圈的 id
      const [imageId, px, py, pw, ph] = args.map((v, i) => (i ? Number(v) : v))
      const img = await p.js(`(() => { const e=window.__flyingdrawsApi.getSceneElements().find(e=>e.id===${JSON.stringify(imageId)}); const f=e&&window.__flyingdrawsApi.getFiles()[e.fileId]; return e && { x:e.x, y:e.y, w:e.width, h:e.height } })()`)
      if (!img) throw new Error('找不到图片元素')
      const natural = await p.js(`(() => new Promise(r => { const e=window.__flyingdrawsApi.getSceneElements().find(e=>e.id===${JSON.stringify(imageId)}); const f=window.__flyingdrawsApi.getFiles()[e.fileId]; const im=new Image(); im.onload=()=>r([im.naturalWidth, im.naturalHeight]); im.src=f.dataURL }))()`)
      const s = img.w / natural[0]
      const cx = img.x + (px + pw / 2) * s, cy = img.y + (py + ph / 2) * s
      const rx = (pw / 2) * s * 1.25 + 6, ry = (ph / 2) * s * 1.35 + 6
      const pts = []
      for (let k = 0; k <= 40; k++) { const a = -Math.PI / 2 + (k / 40) * Math.PI * 2.08; pts.push([Math.cos(a) * rx, Math.sin(a) * ry]) }
      const minX = Math.min(...pts.map(q => q[0])), minY = Math.min(...pts.map(q => q[1]))
      const rel = pts.map(([a, b]) => [a - minX, b - minY])
      const id = `user_loop_${Date.now()}`
      const el = base(id, 'freedraw', cx + minX, cy + minY, Math.max(...rel.map(q => q[0])), Math.max(...rel.map(q => q[1])), { points: rel, pressures: rel.map(() => 0.5), simulatePressure: true, lastCommittedPoint: rel.at(-1) })
      await p.js(`(() => { const api=window.__flyingdrawsApi; api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ${JSON.stringify(el)}] }); })()`)
      console.log(JSON.stringify({ id, canvas: { cx, cy, rx, ry } }))
      break
    }
    case 'select': {
      await p.js(`window.__flyingdrawsApi.updateScene({ appState: { selectedElementIds: ${JSON.stringify(Object.fromEntries(args.map(a => [a, true])))} } })`)
      console.log('已选中', args.join(', '))
      break
    }
    case 'images': {
      console.log(JSON.stringify(await p.js(`window.__flyingdrawsApi.getSceneElements().filter(e=>e.type==='image').map(e=>({ id:e.id, x:Math.round(e.x), y:Math.round(e.y), w:Math.round(e.width), h:Math.round(e.height), meta: e.customData?.flyingdraws }))`), null, 1))
      break
    }
    case 'goal': {
      const text = args.join(' ')
      await p.js(`document.querySelector('.fd-agent-composer textarea').focus()`)
      await p.send('Input.insertText', { text })
      console.log('已填目标')
      break
    }
    case 'run':
    case 'watch': {
      // run：点开始执行后守着新的一轮；watch：守着已经在跑的最后一轮。按规则审批、记录、估算超预算就停
      const label = args[0] ?? 'round'
      const lastRun = async () => { const s = await p.js('window.flyingdraws.agent.state()'); return s.items.find(i => i.id === s.activeItemId)?.runs.at(-1) }
      const previousId = cmd === 'run' ? (await lastRun())?.id : undefined
      const before = cmd === 'run' ? spent() : JSON.parse(args[1] ?? 'null') ?? spent()
      if (cmd === 'run') {
        if (before.cost >= BUDGET) throw new Error(`估算已花 ¥${before.cost.toFixed(2)}，到达上限 ¥${BUDGET}，不再开新一轮`)
        const clicked = await p.js(`(() => { const b=[...document.querySelectorAll('button')].find(b=>!b.disabled&&/^(开始执行|拟定计划)/.test(b.textContent.trim())); if(!b) return false; b.click(); return true })()`)
        if (!clicked) throw new Error('开始执行按钮不可点')
        log({ label, event: 'start', spent: before })
      }
      const t0 = Date.now()
      const answered = new Set()
      let runId = null
      while (true) {
        await sleep(1500)
        const s = await p.js('window.flyingdraws.agent.state()')
        const run = s.items.find(i => i.id === s.activeItemId)?.runs.at(-1)
        if (!run || run.id === previousId) continue // 新一轮还没出现
        if (!runId) runId = run.id
        const remember = args.includes('remember')
        for (const a of run?.approvals ?? []) {
          if (answered.has(a.requestId)) continue
          if (a.answered) {
            if (a.autoApproved) { answered.add(a.requestId); log({ label, event: 'host-auto', name: a.name, preview: a.preview }); console.log(`本任务内已允许（自动）：${a.name} ${a.preview?.slice(0, 120)}`) }
            continue
          }
          answered.add(a.requestId)
          const danger = DANGER.test(`${a.name} ${a.description}`)
          const keep = !danger && remember && Boolean(a.preview)
          await p.js(`window.flyingdraws.agent.approve(${JSON.stringify(a.requestId)}, ${!danger}, ${keep})`).catch(e => log({ label, event: 'approve-error', error: String(e) }))
          log({ label, event: danger ? 'reject' : keep ? 'approve-remember' : 'approve', name: a.name, description: a.description.slice(0, 600) })
          const why = (a.description.match(/未自动放行：[^\n]*/) || [''])[0]
          console.log(`${danger ? '拒绝' : keep ? '本任务内都允许' : '允许'}：${a.name} ${a.preview?.slice(0, 120) ?? ''} ${why}`)
        }
        const now = spent()
        if (now.cost >= BUDGET && s.busy) {
          await p.js('window.flyingdraws.agent.cancel()').catch(() => undefined)
          log({ label, event: 'budget-stop', spent: now })
          console.log(`估算费用到达上限 ¥${BUDGET}，已停止本轮`)
        }
        if (!s.busy && run && run.status !== 'running' && run.id === runId) {
          const after = spent()
          const summary = {
            label, status: run.status, seconds: Math.round((Date.parse(run.endedAt ?? new Date().toISOString()) - Date.parse(run.startedAt)) / 1000),
            wall: Math.round((Date.now() - t0) / 1000),
            cost: +(after.cost - before.cost).toFixed(3), calls: after.calls - before.calls, totalCost: +after.cost.toFixed(3), hitRate: +(after.hitRate * 100).toFixed(1),
            tools: run.tools.length, manualApprovals: run.approvals.filter(a => !a.autoApproved).length,
            autoApproved: run.tools.filter(t => t.autoApproved).map(t => `${t.name}:${t.autoApproved}`),
            changed: run.roundChanges ? run.roundChanges.files.map(f => `${f.status} ${f.path} +${f.additions} -${f.deletions}`) : run.roundChangesNote,
            preexisting: run.roundChanges?.preexisting, compare: run.compareImageId, warning: run.verificationWarning, error: run.error
          }
          log({ event: 'end', ...summary, reply: run.reply })
          console.log(JSON.stringify(summary, null, 1))
          console.log('--- 回复 ---\n' + run.reply)
          break
        }
      }
      break
    }
    case 'save-image': {
      const url = await p.js(`window.flyingdraws.agent.image(${JSON.stringify(args[0])})`)
      writeFileSync(args[1], Buffer.from(url.split(',')[1], 'base64'))
      console.log('已保存', args[1])
      break
    }
    case 'shot': {
      await p.js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
      await sleep(800)
      writeFileSync(args[0], Buffer.from(await p.js('window.flyingdraws.captureWindow()'), 'base64'))
      console.log('已截图', args[0])
      break
    }
    case 'review': {
      const [runId, verdict, ...note] = args
      await p.js(`window.flyingdraws.agent.review(${JSON.stringify(runId)}, ${JSON.stringify(verdict)}, ${JSON.stringify(note.join(' '))})`)
      log({ event: 'review', runId, verdict, note: note.join(' ') })
      console.log('已记录核对结论', verdict)
      break
    }
    case 'spent': {
      const s = spent()
      console.log(`累计 ¥${s.cost.toFixed(3)}（按日志估算），${s.calls} 次调用，缓存命中 ${(s.hitRate * 100).toFixed(1)}%`)
      break
    }
    default: console.log('未知命令', cmd); process.exitCode = 1
  }
} finally {
  p?.close()
}
