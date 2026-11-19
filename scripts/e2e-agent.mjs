// 真 Electron + 真 Fuxi 内核 + 本机 SSE 假供应商。仅写隔离目录，不调用外部模型。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = join(root, 'out', `agent-e2e-${randomUUID()}`)
const output = join(root, 'out', 'e2e')
await mkdir(home, { recursive: true })
await mkdir(output, { recursive: true })
await mkdir(join(home, 'agent'), { recursive: true })
await writeFile(join(home, 'agent', 'work-items.json'), JSON.stringify({ version: 1, items: [{
  id: 'moved-project', board: 'default', cwd: join(home, 'moved-away-project'), sessionId: 'old-session', title: '原项目（已移动）', runs: []
}] }))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let stage = 'draw'
let calls = 0
const requests = []
const provider = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') { res.writeHead(404).end(); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const images = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'image_url').length
    requests.push({ stage, images })
    calls++
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    if (stage === 'hang') { res.write(': waiting\n\n'); return }
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fd-test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    if (['draw', 'read', 'execute'].includes(stage) && calls === 1) {
      const remote = stage === 'read' ? 'canvas_read' : 'canvas_draw'
      const tool = body.tools?.find(tool => tool.function.description?.includes(`/${remote}:`))
      if (!tool) throw new Error(`没有注册 ${remote}`)
      const args = remote === 'canvas_read' ? { board: 'default', as: 'Fuxi', image: 'always' }
        : { board: 'default', as: 'Fuxi', ops: [{ op: 'add_node', id: 'result', label: stage === 'execute' ? '确认执行已通' : '内核接入已通' }] }
      send({ tool_calls: [{ index: 0, id: `call-${stage}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(args) } }] })
      send({}, 'tool_calls')
    } else {
      send({ content: stage === 'plan' ? '计划：读取画布结构；在空位新增结果节点；说明完成情况，等待确认执行。' : '## 工作区核对\n\n| 动作 | 结果 |\n|---|---|\n| `canvas_read` | **已完成** |\n\n[参考](https://example.org/) · [x](javascript:alert(1)) · <img src=x onerror=alert(1)>' })
      send({}, 'stop')
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  } catch (error) { res.end(`data: ${JSON.stringify({ error: { message: String(error.message) } })}\n\n`) }
})
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
const providerPort = provider.address().port
const reservation = createTcpServer()
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
const debugPort = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const env = { ...process.env, FLYINGDRAWS_HOME: relative(root, home), FLYINGDRAWS_DEBUG_PORT: String(debugPort), FLYINGDRAWS_TEST_HIDDEN: '1' }
delete env.ELECTRON_RUN_AS_NODE
const packaged = process.env.FLYINGDRAWS_E2E_APP
const bridgeRoot = packaged ? join(dirname(packaged), 'resources', 'app') : root
const electron = packaged || join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const child = spawn(electron, packaged ? [] : [root], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
let diagnostics = ''
let launchError
child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4000) })
child.once('error', error => { launchError = error })
let ws
let client
let js
const until = async (check, label, timeout = 20000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await delay(100)
  }
  throw new Error(`等待超时：${label}`)
}
try {
  const page = await until(async () => {
    if (launchError || child.exitCode !== null || child.signalCode !== null) throw new Error(`应用启动失败：${launchError?.message || child.exitCode}\n${diagnostics}`)
    try { return (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find(page => page.type === 'page') } catch { return null }
  }, 'Electron 页面')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(resolve => ws.addEventListener('open', resolve))
  let serial = 0
  const pending = new Map()
  ws.addEventListener('message', event => {
    const reply = JSON.parse(event.data)
    const item = pending.get(reply.id)
    if (item) { clearTimeout(item.timer); pending.delete(reply.id); item.resolve(reply) }
  })
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial
    pending.set(id, { resolve, timer: setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)) }, 20000) })
    ws.send(JSON.stringify({ id, method, params }))
  })
  js = async expression => {
    let reply
    try { reply = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) }
    catch (error) { throw new Error(`${error.message} · ${expression.slice(0, 85)}`) }
    if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description || '页面执行失败')
    return reply.result?.result?.value
  }
  const click = async label => {
    const selector = `[...document.querySelectorAll('button')].find(b=>!b.disabled&&b.textContent.trim().startsWith(${JSON.stringify(label)}))`
    await until(() => js(`Boolean(${selector})`), `按钮 ${label}`)
    await js(`(${selector}).click()`)
  }
  const setPlanFirst = async checked => {
    await until(() => js(`Boolean(document.querySelector('.fd-agent-composer input[type=checkbox]:not(:disabled)'))`), '规划开关就绪')
    await js(`(() => { const e=document.querySelector('.fd-agent-composer input[type=checkbox]'); if(e.checked!==${checked}) e.click(); })()`)
    await until(() => js(`document.querySelector('.fd-agent-composer input[type=checkbox]').checked===${checked}`), '规划开关同步')
  }
  const fill = (label, text) => js(`(() => { const l=[...document.querySelectorAll('.fd-agent-settings label')].find(l=>l.textContent.trim().startsWith(${JSON.stringify(label)})); const e=l?.querySelector('input'); if(!e) throw Error('找不到输入框'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(text)}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`)
  const goal = async text => {
    await until(() => js(`Boolean(document.querySelector('.fd-agent-composer textarea:not(:disabled)'))`), '任务输入框就绪')
    await js(`document.querySelector('.fd-agent-composer textarea').focus()`)
    await cdp('Input.insertText', { text })
  }
  const state = () => js('window.flyingdraws.agent.state()')
  const activeItem = async () => { const value = await state(); return value.items.find(item => item.id === value.activeItemId) }
  const finished = (afterId = null) => until(async () => {
    const s = await state()
    const run = s.items.find(item => item.id === s.activeItemId)?.runs.at(-1)
    return !s.busy && run && run.id !== afterId && run.status !== 'running' ? run : null
  }, '任务结束', 30000)
  await until(() => js('Boolean(window.__flyingdrawsApi)'), '画布 API')
  console.log('✔ 隔离画布页面就绪')
  await click('内置 Agent')
  await until(async () => (await state()).connection === 'ready', '内核就绪')
  assert.ok((await state()).workspaceWarning, '丢失工作目录时没有给出恢复提示')
  assert.equal((await state()).activeItemId, null)
  console.log('✔ Electron 与内置 Fuxi 初始化完成')
  await click('模型设置')
  const settingsField = label => `[...document.querySelectorAll('.fd-agent-settings label')].find(l=>l.textContent.trim().startsWith(${JSON.stringify(label)}))`
  const visionChecked = `document.querySelector('.fd-agent-settings input[type=checkbox]').checked`
  // 默认是已实测的 deepseek-flash 预设：只差密钥，看图默认打开
  await until(() => js(`Boolean(${settingsField('服务商')})`), '模型设置表单')
  assert.deepEqual(await js(`({ url: ${settingsField('服务地址')}.querySelector('input').value, model: ${settingsField('模型 ID')}.querySelector('input').value, vision: ${visionChecked} })`),
    { url: 'https://api.deepseek.com/v1', model: 'deepseek-flash', vision: true })
  const keyValue = `${settingsField('API Key')}.querySelector('input').value`
  const presetValue = `${settingsField('服务商')}.querySelector('select').value`
  const selectPreset = id => js(`(() => { const s=${settingsField('服务商')}.querySelector('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(id)}); s.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  // 预设下把服务地址改到别的主机：已填的密钥清空，服务商不再显示为预设
  await fill('API Key', 'fd-should-be-cleared')
  await fill('服务地址', 'https://example.invalid/v1')
  await until(() => js(`${keyValue}==='' && ${presetValue}==='custom'`), '改主机后清空密钥')
  // 切回预设、填上密钥，再换成自定义：密钥和表单都清空，看图要用户自己勾
  await selectPreset('deepseek-flash')
  await fill('API Key', 'fd-should-be-cleared')
  await selectPreset('custom')
  await until(() => js(`!${visionChecked} && ${settingsField('模型 ID')}.querySelector('input').value==='' && ${keyValue}===''`), '切到自定义服务商')
  console.log('✔ 模型设置默认是 deepseek-flash 预设；换服务商或改主机都会清空密钥')
  await fill('配置名称', 'fd-test')
  await fill('服务地址', `http://127.0.0.1:${providerPort}/v1`)
  await fill('API Key', 'fd-e2e-not-a-real-key')
  await fill('模型 ID', 'fd-mock')
  await js(`document.querySelector('.fd-agent-settings input[type=checkbox]').click()`)
  await click('保存并使用')
  await until(async () => (await state()).vision && !(await state()).setupNeeded, '模型保存与切换')
  // 设置区（模型、工作目录、任务）能收起成一行摘要给对话让位置，状态记在本机，点摘要再展开
  await click('收起')
  await until(() => js(`Boolean(document.querySelector('.fd-agent-context-summary'))`), '设置区收起')
  assert.ok((await js(`document.querySelector('.fd-agent-context-summary').textContent`)).includes('fd-mock'), '收起后的摘要里应有当前模型')
  assert.equal(await js(`localStorage.getItem('fd:agent-context-collapsed')`), '1')
  assert.equal(await js(`Boolean(document.querySelector('.fd-agent-model-row'))`), false)
  await js(`document.querySelector('.fd-agent-context-summary').click()`)
  await until(() => js(`Boolean(document.querySelector('.fd-agent-model-row'))`), '设置区展开')
  assert.equal(await js(`localStorage.getItem('fd:agent-context-collapsed')`), '0')
  console.log('✔ 设置区可以收起成一行摘要再展开，状态记在本机')
  const sdk = path => pathToFileURL(join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm', path)).href
  const { Client } = await import(sdk('client/index.js'))
  const { StdioClientTransport } = await import(sdk('client/stdio.js'))
  client = new Client({ name: 'fd-agent-test', version: '1' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(bridgeRoot, 'out/bridge/index.js')], env, stderr: 'pipe' }))
  await client.callTool({ name: 'canvas_draw', arguments: { board: 'default', ops: [{ op: 'add_node', id: 'idea', label: '想法' }] } })
  await until(() => js(`Boolean(document.querySelector('.fd-agent-composer input[type=checkbox]'))`), '规划开关出现')
  assert.equal(await js(`document.querySelector('.fd-agent-composer input[type=checkbox]').checked`), false, '新打开时应默认直接执行，不先拟计划')
  await setPlanFirst(false)
  await goal('请在画布上新增一个结果节点')
  await click('开始执行')
  await until(() => js('Boolean(document.querySelector(".fd-agent-approval"))'), '工具审批')
  await click('本次允许')
  const first = await finished()
  assert.ok(['completed', 'unverified'].includes(first.status), first.error || first.status)
  assert.ok(requests.some(request => request.stage === 'draw' && request.images > 0), '首轮截图没有传入模型')
  await until(() => js(`[...document.querySelectorAll('.fd-agent-reply')].some(el =>
    el.querySelector('h2')?.textContent === '工作区核对' && el.querySelector('table td code')?.textContent === 'canvas_read'
    && el.querySelector('td strong')?.textContent === '已完成' && !el.textContent.includes('|---|')
    && el.querySelectorAll('a').length === 1 && el.querySelector('a[href="https://example.org/"][target="_blank"][rel="noopener noreferrer"]')
    && !el.querySelector('img') && el.textContent.includes('[x](javascript:alert(1))'))`), '回复显示 Markdown 标题和表格')
  const board = await client.callTool({ name: 'canvas_read', arguments: { image: 'never' } })
  assert.match(JSON.stringify(board), /内核接入已通/)
  const session = (await activeItem()).sessionId
  assert.notEqual(session, 'old-session')
  console.log('✔ 界面保存模型、首轮图片、审批及画布回填完成')
  stage = 'read'; calls = 0
  await goal('请读取当前画布图片并说明结构')
  await click('开始执行')
  await until(() => js('Boolean(document.querySelector(".fd-agent-approval"))'), '读取画布审批')
  await click('本次允许')
  const second = await finished()
  assert.ok(['completed', 'unverified'].includes(second.status), second.error || second.status)
  const reads = requests.filter(request => request.stage === 'read')
  assert.ok(reads.length >= 2 && reads.at(-1).images > reads[0].images, 'MCP 图像没有进入后续模型请求')
  assert.equal((await activeItem()).sessionId, session)
  assert.notEqual(first.taskId, second.taskId)
  await until(() => js('Boolean(document.querySelector(".fd-agent-result-image img"))'), '工具结果图片预览')
  await js(`(() => { const api=window.__flyingdrawsApi; const first=api.getSceneElements()[0]; api.updateScene({elements:[...api.getSceneElementsIncludingDeleted(),{...first,id:'deleted-for-test',boundElements:[],isDeleted:true,x:100000,y:100000}]}); })()`)
  await click('我画的')
  await click('放到画布')
  await until(() => js('window.__flyingdrawsApi.getSceneElements().some(e=>e.type==="image")'), '结果图片回到画布')
  assert.equal(await js(`window.__flyingdrawsApi.getSceneElementsIncludingDeleted().some(e=>e.id==='deleted-for-test'&&e.isDeleted)`), true)
  assert.equal(await js(`window.__flyingdrawsApi.getSceneElements().filter(e=>e.customData?.flyingdraws?.author==='agent').every(e=>e.opacity===0&&e.locked)`), true)
  assert.equal(await js(`window.__flyingdrawsApi.getSceneElements().filter(e=>e.type==='image').every(e=>e.y<10000)`), true)
  await click('全部')
  console.log('✔ Completed 后同会话新任务及 MCP 图片回传完成')
  stage = 'plan'; calls = 0
  await setPlanFirst(true)
  await goal('先规划，再在画布上增加确认结果')
  await click('拟定计划')
  const planned = await finished(second.id)
  assert.equal(planned.status, 'planned', planned.error || planned.status)
  stage = 'execute'; calls = 0
  await click('确认并执行')
  await until(() => js('Boolean(document.querySelector(".fd-agent-approval"))'), '计划执行审批')
  await click('本次允许')
  assert.ok(['completed', 'unverified'].includes((await finished(planned.id)).status))
  console.log('✔ 计划确认和控制器执行完成')
  stage = 'hang'; calls = 0
  await setPlanFirst(false)
  await goal('保持等待以验证停止')
  await click('开始执行')
  await until(() => Promise.resolve(requests.some(request => request.stage === 'hang')), '等待中的请求')
  const refusedRename = await client.callTool({ name: 'canvas_rename', arguments: { board: 'default', new_board: 'during-run' } })
  assert.equal(refusedRename.isError, true)
  assert.match(JSON.stringify(refusedRename), /先停止该画板/)
  await click('停止')
  const cancelled = await finished()
  assert.equal(cancelled.status, 'cancelled')
  console.log('✔ 停止请求完成，模型调用全部来自本机假供应商')
  stage = 'resume'; calls = 0
  await goal('继续原任务，说明当前结果')
  await click('继续原任务')
  const resumed = await finished(cancelled.id)
  assert.ok(['completed', 'unverified'].includes(resumed.status), resumed.error || resumed.status)
  assert.equal(resumed.taskId, cancelled.taskId)
  await client.callTool({ name: 'canvas_rename', arguments: { board: 'default', new_board: 'agent-history-check' } })
  assert.equal((await activeItem()).board, 'agent-history-check')
  await client.callTool({ name: 'canvas_rename', arguments: { board: 'agent-history-check', new_board: 'default' } })
  assert.equal((await activeItem()).board, 'default')
  console.log('✔ 显式续接保留原task，画板重命名保留任务归属，运行时禁止改名')
  // YOLO：开启后整轮不再出现审批，侧栏显示红色标识；关掉后恢复询问
  await js(`window.flyingdraws.agent.setApprovalMode('full-access')`)
  assert.equal((await state()).approvalMode, 'full-access')
  await until(() => js(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'YOLO · 开')`), 'YOLO 标识')
  stage = 'draw'; calls = 0
  await setPlanFirst(false)
  await goal('YOLO 下在画布上新增一个结果节点')
  await click('开始执行')
  const yoloRun = await finished(resumed.id)
  assert.ok(['completed', 'unverified'].includes(yoloRun.status), yoloRun.error || yoloRun.status)
  assert.equal(yoloRun.approvals.length, 0, 'YOLO 下不应出现审批')
  await js(`window.flyingdraws.agent.setApprovalMode('auto-safe')`)
  stage = 'draw'; calls = 0
  await goal('关掉 YOLO 后再新增一个结果节点')
  await click('开始执行')
  await until(() => js('Boolean(document.querySelector(".fd-agent-approval"))'), '关掉 YOLO 后恢复审批')
  await click('本次允许')
  assert.ok(['completed', 'unverified'].includes((await finished(yoloRun.id)).status))
  console.log('✔ YOLO 开启后整轮无审批，关闭后恢复询问')
  await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  const shot = await js('window.flyingdraws.captureWindow()')
  await writeFile(join(output, 'agent.png'), Buffer.from(shot, 'base64'))
  await js(`window.__flyingdrawsApi.updateScene({appState:{theme:'dark'}})`)
  await delay(250)
  const dark = await js('window.flyingdraws.captureWindow()')
  await writeFile(join(output, 'agent-dark.png'), Buffer.from(dark, 'base64'))
  await writeFile(join(output, 'agent-report.json'), JSON.stringify({ passed: true, requests: requests.length, images: requests.map(request => request.images), externalModels: false }, null, 2))
  console.log(`✔ 截图：${join(output, 'agent.png')}`)
} finally {
  await client?.close().catch(() => undefined)
  if (js) await js('window.flyingdraws.agent.cancel()').catch(() => undefined)
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }))
  await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(7000)])
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    if (process.platform === 'win32') await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, resolve))
    else child.kill()
  }
  ws?.close()
  provider.closeAllConnections()
  await new Promise(resolve => provider.close(resolve))
  const relativeHome = relative(join(root, 'out'), home)
  if (relativeHome.startsWith('..') || isAbsolute(relativeHome)) throw new Error('拒绝清理工作区外的测试目录')
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
