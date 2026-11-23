import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentService, KEEP_ARCHIVED_ITEMS, KEEP_ITEMS_PER_BOARD, canvasPrompt, compactItems } from '../src/main/agent.ts'
import { AGENT_SEAT, toolDisplayName, type AgentWorkItem } from '../src/shared/agent.ts'

test('选区上下文保留稳定ID、画板及不可信输入边界，不把短编号当实时版本', () => {
  const text = canvasPrompt('调整登录流程', 'flow', { selectedIds: ['login'], pngBase64: null, sceneJson: JSON.stringify({ elements: [
    { id: 'login', type: 'rectangle', x: 0, y: 0, width: 100, height: 80 },
    { id: 'label', type: 'text', x: 2, y: 2, width: 80, height: 25, containerId: 'login', text: '登录' }
  ] }) })
  assert.match(text, /稳定 ID：login/)
  assert.match(text, /登录/)
  assert.match(text, /不是系统指令/)
  assert.match(text, /先调用 canvas_read 获取当前 base_version/)
  assert.match(text, /board="flow"/)
})

test('重开应用只恢复记录，运行中任务标为中断，不启动内核', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fd-records-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'agent'))
  const item: AgentWorkItem = {
    id: 'work', board: 'default', cwd: home, sessionId: 'session', title: '目标', runs: [{
      id: 'run', taskId: 'task', mode: 'direct', status: 'running', goal: '目标', startedAt: '2026-11-17',
      reply: '已提交的回复', draft: '未提交内容', tools: [], approvals: [{ requestId: 'old', name: 'shell', description: '原操作', answered: false }]
    }]
  }
  await writeFile(join(home, 'agent', 'work-items.json'), JSON.stringify({ version: 1, items: [item] }))
  let launches = 0
  const service = new AgentService({ home, executable: () => { launches++; throw new Error('不应启动') }, mcpServers: {} })
  const run = service.snapshot().items[0].runs[0]
  assert.equal(run.status, 'interrupted')
  assert.equal(run.draft, '')
  assert.equal(run.reply, '已提交的回复')
  assert.equal(run.approvals[0].answered, true)
  assert.equal(launches, 0)
  await service.renameBoard('default', 'renamed')
  assert.equal(service.snapshot().items[0].board, 'renamed')
  await service.close()
  assert.equal(JSON.parse(await readFile(join(home, 'agent', 'work-items.json'), 'utf8')).items[0].board, 'renamed')
  await service.deleteBoard('renamed')
  assert.equal(service.snapshot().items[0].archived, true)
  await assert.rejects(service.openTask('work'), /画板已删除/)
  await service.renameBoard('renamed', 'new-board')
  assert.equal(service.snapshot().items[0].board, 'renamed')
  await service.close()
})

test('画板变更期间拒绝新任务，防止任务引用到已改名的画板', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fd-board-change-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const service = new AgentService({ home, executable: () => { throw new Error('不应启动') }, mcpServers: {} })
  await service.withBoardChange('default', async () => {
    await assert.rejects(service.submit({ board: 'default', goal: '目标', mode: 'direct', capture: { sceneJson: '{"elements":[]}', selectedIds: [], pngBase64: null } }), /画板正在更新/)
  })
  await service.close()
})

test('坏的历史保留原文备份，新任务记录仍能正常保存', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fd-invalid-history-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'agent'))
  const file = join(home, 'agent', 'work-items.json')
  await writeFile(file, '{invalid')
  const service = new AgentService({ home, executable: () => '', mcpServers: {} })
  assert.match(service.snapshot().recordsWarning!, /已保留备份/)
  await service.close()
  const backup = (await readdir(join(home, 'agent'))).find(name => name.startsWith('work-items.corrupt-'))!
  assert.equal(await readFile(join(home, 'agent', backup), 'utf8'), '{invalid')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, items: [] })
})

test('未知版本的记录不降级覆盖，并明确拒绝开始未落盘的任务', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fd-future-history-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'agent'))
  const file = join(home, 'agent', 'work-items.json')
  const original = JSON.stringify({ version: 99, items: [{ future: true }] })
  await writeFile(file, original)
  const service = new AgentService({ home, executable: () => { throw new Error('不应启动') }, mcpServers: {} })
  await assert.rejects(service.submit({ board: 'default', goal: '任务', mode: 'direct', capture: { sceneJson: '{"elements":[]}', selectedIds: [], pngBase64: null } }), /兼容的应用版本/)
  await service.close()
  assert.equal(await readFile(file, 'utf8'), original)
})

test('思考内容按轮折叠保存：流式预览被最终消息替换，被停止的轮次保留已有思考', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fd-thinking-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'agent'))
  const item: AgentWorkItem = {
    id: 'work', board: 'default', cwd: home, sessionId: 'session', title: '目标',
    runs: [{ id: 'run', mode: 'direct', status: 'completed', goal: '目标', startedAt: '2026-11-17', reply: '', draft: '', tools: [], approvals: [] }]
  }
  await writeFile(join(home, 'agent', 'work-items.json'), JSON.stringify({ version: 1, items: [item] }))
  const service = new AgentService({ home, executable: () => { throw new Error('不应启动') }, mcpServers: {} })
  const send = (event: string, data: Record<string, unknown>) =>
    (service as unknown as { onEvent(e: unknown): void }).onEvent({ type: 'event', seq: 1, run_id: 'run', req: 1, event, data })
  send('thinking_delta', { text: '先看' })
  send('thinking_delta', { text: '画布' })
  assert.equal(service.snapshot().items[0].runs[0].thinkingDraft, '先看画布')
  send('assistant_message', { message: { content: [{ type: 'thinking', thinking: '先看画布，再回答。' }, { type: 'text', text: '你好' }] } })
  let run = service.snapshot().items[0].runs[0]
  assert.equal(run.thinking, '先看画布，再回答。')
  assert.equal(run.thinkingDraft, '')
  assert.equal(run.reply, '你好')
  // A cancelled turn has no final message: the streamed reasoning is kept.
  send('thinking_delta', { text: '第二步想到一半' })
  send('run_finished', { outcome: { status: 'cancelled' } })
  run = service.snapshot().items[0].runs[0]
  assert.equal(run.thinking, '先看画布，再回答。\n\n第二步想到一半')
  assert.equal(run.thinkingDraft, '')
  await service.close()
  const saved = JSON.parse(await readFile(join(home, 'agent', 'work-items.json'), 'utf8')).items[0].runs[0]
  assert.equal(saved.thinking, '先看画布，再回答。\n\n第二步想到一半')
  assert.equal(saved.thinkingDraft, '')
})

test('工具显示名：内核报告的 MCP 原名优先，没有时退回可读名称', () => {
  const labels = { mcp_flying_draws_6: 'flying_draws/canvas_read', mcp_other_0: 'other/lookup' }
  assert.equal(toolDisplayName('mcp_flying_draws_6', labels), '读取画布')
  assert.equal(toolDisplayName('mcp_other_0', labels), 'other/lookup')
  assert.equal(toolDisplayName('mcp_flying_draws_6'), 'flying-draws 的外部工具')
  assert.equal(toolDisplayName('read_file'), '读取文件')
  assert.equal(toolDisplayName('custom_tool'), 'custom_tool')
})

test('内置 Agent 在画布上用统一的席位名', () => {
  const prompt = canvasPrompt('目标', 'default', { sceneJson: '{"elements":[]}', selectedIds: [], pngBase64: null })
  assert.ok(prompt.includes(`as=${JSON.stringify(AGENT_SEAT)}`))
  assert.equal(AGENT_SEAT, 'Fuxi')
})

test('工具返回截图时记录原图尺寸、页面 URL、视口和轮次元数据', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fd-img-meta-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'agent'))
  const item: AgentWorkItem = {
    id: 'work1',
    board: 'default',
    cwd: home,
    sessionId: 's1',
    title: '改登录页',
    runs: [
      { id: 'r1', mode: 'direct', status: 'completed', goal: '首轮', startedAt: '2026-11-18', reply: 'ok', draft: '', tools: [], approvals: [] },
      { id: 'r2', taskId: 't2', mode: 'direct', status: 'running', goal: '二轮', startedAt: '2026-11-18', reply: '', draft: '', tools: [{ id: 'tc1', name: 'browser_page', input: '{}', status: 'running' }], approvals: [] }
    ]
  }
  await writeFile(join(home, 'agent', 'work-items.json'), JSON.stringify({ version: 1, items: [item] }))
  const service = new AgentService({ home, executable: () => '', mcpServers: {} })
  const png = Buffer.alloc(32)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]).copy(png, 0)
  png.writeUInt32BE(1280, 16)
  png.writeUInt32BE(720, 20)
  ;(service as unknown as { onEvent(e: unknown): void }).onEvent({
    type: 'event',
    seq: 2,
    run_id: 'r2',
    req: 1,
    event: 'tool_done',
    data: {
      id: 'tc1',
      name: 'browser_page',
      is_error: false,
      content: JSON.stringify({ untrusted_page_observation: { url: 'http://127.0.0.1:5173/' }, width: 1280, height: 720 }),
      image: { media_type: 'image/png', dimensions: [1280, 720], data: png.toString('base64') }
    }
  })
  await service.close()
  const saved = JSON.parse(await readFile(join(home, 'agent', 'work-items.json'), 'utf8')).items[0].runs[1]
  assert.equal(saved.images.length, 1)
  assert.equal(saved.images[0].meta.naturalWidth, 1280)
  assert.equal(saved.images[0].meta.naturalHeight, 720)
  assert.equal(saved.images[0].meta.url, 'http://127.0.0.1:5173/')
  assert.deepEqual(saved.images[0].meta.viewport, { w: 1280, h: 720 })
  assert.equal(saved.images[0].meta.round, 2)
})

test('openTask 只调用一次 workspace.open；setWorkspace 过渡期间拒绝并发操作且失败不污染 workspace；starting 时拒绝切换审批模式', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fd-lifecycle-'))
  const ws1 = join(home, 'ws1')
  const ws2 = join(home, 'ws2')
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'agent'), { recursive: true })
  await mkdir(ws1, { recursive: true })
  await mkdir(ws2, { recursive: true })
  const item: AgentWorkItem = {
    id: 'w1', board: 'b1', cwd: ws1, sessionId: 's1', title: '任务一',
    runs: [{ id: 'r1', mode: 'direct', status: 'completed', goal: '目标', startedAt: '2026-11-18', reply: 'ok', draft: '', tools: [], approvals: [] }]
  }
  await writeFile(join(home, 'agent', 'work-items.json'), JSON.stringify({ version: 1, items: [item] }))
  const service = new AgentService({ home, executable: () => { throw new Error('不应启动真实内核') }, mcpServers: {} })
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let openGate: (() => void) | null = null
  let failNextOpen = false
  const live = service as unknown as { client: unknown }
  live.client = {
    alive: true,
    stop: async () => undefined,
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'workspace.open') {
        if (openGate) await new Promise<void>(resolve => { const g = openGate!; openGate = () => { g(); resolve() } })
        if (failNextOpen) { failNextOpen = false; throw new Error('打开失败') }
        return { session_id: String(params.session_id ?? 'new-s'), provider: 'p', model: 'm', setup_needed: false, vision: false, choices: [] }
      }
      return {}
    }
  }

  // openTask 只发一次 workspace.open
  await service.openTask('w1')
  assert.equal(calls.filter(c => c.method === 'workspace.open').length, 1)
  assert.equal(calls[0].params.session_id, 's1')
  const prevWorkspace = service.snapshot().workspace

  // setWorkspace 进行中：拒绝并发 submit 和 setApprovalMode，且 workspace 未提前改写
  let releaseOpen: (() => void) | null = null
  live.client = {
    alive: true,
    stop: async () => undefined,
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'workspace.open') {
        await new Promise<void>(resolve => { releaseOpen = resolve })
        if (failNextOpen) { failNextOpen = false; throw new Error('打开失败') }
        return { session_id: 's2', provider: 'p', model: 'm', setup_needed: false, vision: false, choices: [] }
      }
      return {}
    }
  }
  failNextOpen = true
  const switching = service.setWorkspace('b1', ws2)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(service.snapshot().workspace, prevWorkspace)
  await assert.rejects(
    service.submit({ board: 'b1', goal: '并发', mode: 'direct', capture: { sceneJson: '{"elements":[]}', selectedIds: [], pngBase64: null } }),
    /另一项操作正在进行/
  )
  await assert.rejects(service.setApprovalMode('full-access'), /正在连接/)
  releaseOpen!()
  await assert.rejects(switching, /打开失败/)
  assert.equal(service.snapshot().workspace, prevWorkspace)
  await service.close()
})

test('冷启动 submit 保留上一轮 reviewContext；session_reset 同步活动任务 sessionId；离线自动审批不抛错；close 等待 deferredEvents 落盘', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fd-review-ctx-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'agent'), { recursive: true })
  const item: AgentWorkItem = {
    id: 'w1', board: 'default', cwd: home, sessionId: 's1', title: '改按钮',
    allowedCommands: [{ name: 'pwsh', input: '{"command":"echo hi"}' }],
    runs: [{
      id: 'r1', mode: 'direct', status: 'rejected', goal: '首轮', startedAt: '2026-11-18',
      reply: '已改', draft: '', tools: [], approvals: [],
      review: { verdict: 'rejected', decidedAt: '2026-11-18', note: '按钮偏右了' }
    }]
  }
  await writeFile(join(home, 'agent', 'work-items.json'), JSON.stringify({ version: 1, items: [item] }))
  const service = new AgentService({ home, executable: () => { throw new Error('不应启动真实内核') }, mcpServers: {} })
  const sentRuns: Record<string, unknown>[] = []
  const live = service as unknown as {
    client: unknown
    deferredEvents: Promise<void> | null
    autoApproved: Map<string, string>
    onEvent(e: unknown): void
  }
  live.client = {
    alive: true,
    stop: async () => undefined,
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === 'workspace.open') return { session_id: 's1', provider: 'p', model: 'm', setup_needed: false, vision: false, choices: [] }
      if (method === 'run.start') { sentRuns.push(params); return {} }
      return {}
    }
  }

  // 冷启动（activeItemId 为 null）直接 submit：prompt 必须包含上一轮 reviewContext
  assert.equal(service.snapshot().activeItemId, null)
  await service.submit({ board: 'default', goal: '再调一下', mode: 'direct', capture: { sceneJson: '{"elements":[]}', selectedIds: [], pngBase64: null } })
  assert.equal(sentRuns.length, 1)
  assert.match(String(sentRuns[0].text), /按钮偏右了/)

  // session_reset 同步到当前活动工作项的 sessionId
  const runId = service.snapshot().items[0].runs[1].id
  live.onEvent({ type: 'event', seq: 1, run_id: runId, req: 1, event: 'session_reset', data: { session_id: 's-reset-2' } })
  assert.equal(service.snapshot().items[0].sessionId, 's-reset-2')

  // autoApproved 在 run_finished 时清空
  live.onEvent({ type: 'event', seq: 2, run_id: runId, req: 1, event: 'tool_auto_approved', data: { id: 'orphan-tool', auto_approved: 'readonly_shell' } })
  assert.equal(live.autoApproved.size, 1)
  live.onEvent({ type: 'event', seq: 3, run_id: runId, req: 1, event: 'run_finished', data: { outcome: { status: 'completed' } } })
  if (live.deferredEvents) await live.deferredEvents
  assert.equal(live.autoApproved.size, 0)

  // 客户端离线时收到命中已记住规则的 approval_request，不抛错且不误标 answered
  live.client = { alive: false, stop: async () => undefined, request: async () => { throw new Error('dead') } }
  live.onEvent({
    type: 'event', seq: 4, run_id: runId, req: 1, event: 'approval_request',
    data: { request_id: 'req-offline', id: 'tool-offline', name: 'pwsh', description: '操作预览：pwsh: {"command":"echo hi"}' }
  })
  assert.equal(service.snapshot().items[0].runs[1].approvals.at(-1)?.answered, false)

  // close() 等待 deferredEvents 完成后再 persist()
  live.deferredEvents = new Promise<void>(resolve => {
    setTimeout(() => {
      service.snapshot() // no-op
      ;(service as unknown as { state: { items: AgentWorkItem[] } }).state.items[0].title = '收尾后标题'
      live.deferredEvents = null
      resolve()
    }, 30)
  })
  await service.close()
  const saved = JSON.parse(await readFile(join(home, 'agent', 'work-items.json'), 'utf8')).items[0]
  assert.equal(saved.title, '收尾后标题')
  assert.equal(saved.sessionId, 's-reset-2')
})

test('deleteTask 删除指定任务、重置当前活动会话，并在快照清理时回收孤立结果图片', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fd-delete-task-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const imagesDir = join(home, 'agent', 'images')
  await mkdir(imagesDir, { recursive: true })
  const img1Bytes = Buffer.from('image-one')
  const img2Bytes = Buffer.from('image-two')
  const img1Id = createHash('sha256').update(img1Bytes).digest('hex')
  const img2Id = createHash('sha256').update(img2Bytes).digest('hex')
  await writeFile(join(imagesDir, img1Id), img1Bytes)
  await writeFile(join(imagesDir, img2Id), img2Bytes)

  const items: AgentWorkItem[] = [
    {
      id: 'w1', board: 'default', cwd: home, sessionId: 's1', title: '任务一',
      runs: [{
        id: 'r1', mode: 'direct', status: 'completed', goal: '目标一', startedAt: '2026-11-18',
        reply: 'ok', draft: '', tools: [], approvals: [],
        images: [{ id: img1Id, mediaType: 'image/png', name: 'img1' }]
      }]
    },
    {
      id: 'w2', board: 'default', cwd: home, sessionId: 's2', title: '任务二',
      runs: [{
        id: 'r2', mode: 'direct', status: 'completed', goal: '目标二', startedAt: '2026-11-18',
        reply: 'ok', draft: '', tools: [], approvals: [],
        images: [{ id: img2Id, mediaType: 'image/png', name: 'img2' }]
      }]
    }
  ]
  await writeFile(join(home, 'agent', 'work-items.json'), JSON.stringify({ version: 1, items }))
  const service = new AgentService({ home, executable: () => { throw new Error('不应启动真实内核') }, mcpServers: {} })
  const openCalls: Record<string, unknown>[] = []
  ;(service as unknown as { client: unknown }).client = {
    alive: true,
    stop: async () => undefined,
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === 'workspace.open') {
        openCalls.push(params)
        return { session_id: String(params.session_id ?? 'fresh-session'), provider: 'p', model: 'm', setup_needed: false, vision: false, choices: [] }
      }
      return {}
    }
  }

  await assert.rejects(service.deleteTask('non-existent'), /没有找到这项任务/)
  await service.openTask('w1')
  assert.equal(service.snapshot().activeItemId, 'w1')

  // 删除当前活动任务 w1：activeItemId 置空并重新打开新会话
  await service.deleteTask('w1')
  assert.equal(service.snapshot().activeItemId, null)
  assert.deepEqual(service.snapshot().items.map(i => i.id), ['w2'])
  assert.equal(openCalls.at(-1)?.new_session, true)

  // 立即触发回收：w1 的孤立图片 img1Id 被清理，w2 的 img2Id 保留
  await service.maybePruneSnapshots(true)
  const remainingImages = await readdir(imagesDir)
  assert.deepEqual(remainingImages, [img2Id])
  await service.close()
})

test('compactItems 按画板限制任务数、保留归档上限，并裁剪较早历史任务的思考与工具输出', () => {
  const total = KEEP_ITEMS_PER_BOARD + 5
  const items: AgentWorkItem[] = []
  for (let i = 1; i <= total; i++) {
    items.push({
      id: `item-${i}`,
      board: 'b1',
      cwd: '/tmp',
      sessionId: `s-${i}`,
      title: `任务 ${i}`,
      runs: [{
        id: `run-${i}`,
        mode: 'direct',
        status: 'completed',
        goal: `目标 ${i}`,
        startedAt: '2026-11-18',
        reply: 'done',
        draft: '',
        thinking: '思'.repeat(6_000),
        tools: [{ id: `t-${i}`, name: 'read_file', input: '入'.repeat(5_000), status: 'completed', result: '出'.repeat(5_000) }],
        approvals: []
      }]
    })
  }
  for (let i = 1; i <= KEEP_ARCHIVED_ITEMS + 3; i++) {
    items.push({
      id: `arch-${i}`,
      board: 'deleted',
      cwd: '/tmp',
      sessionId: `sa-${i}`,
      title: `归档 ${i}`,
      archived: true,
      runs: [{
        id: `arun-${i}`,
        mode: 'direct',
        status: 'completed',
        goal: '归档目标',
        startedAt: '2026-11-18',
        reply: 'ok',
        draft: '',
        thinking: '旧'.repeat(6_000),
        tools: [],
        approvals: []
      }]
    })
  }

  // activeItemId 指向最早的 item-1，确保即使超出窗口也被保留
  const compacted = compactItems(items, 'item-1')
  const nonArchived = compacted.filter(i => !i.archived)
  const archived = compacted.filter(i => i.archived)
  assert.equal(nonArchived.length, KEEP_ITEMS_PER_BOARD)
  assert.equal(archived.length, KEEP_ARCHIVED_ITEMS)
  assert.ok(nonArchived.some(i => i.id === 'item-1'))
  assert.ok(!nonArchived.some(i => i.id === 'item-2'))

  // 较早的非活动历史任务（如 item-10）思考被裁剪到 4000 字符（带前导省略号共 4001），工具输入/输出被裁剪到 2000
  const oldInactive = nonArchived.find(i => i.id === 'item-10')!
  assert.equal(oldInactive.runs[0].thinking?.length, 4_001)
  assert.ok(oldInactive.runs[0].thinking?.startsWith('…'))
  assert.equal(oldInactive.runs[0].tools[0].input.length, 2_000)
  assert.equal(oldInactive.runs[0].tools[0].result?.length, 2_000)

  // 最近的任务（如最后一篇）和当前活动任务 item-1 保持完整思考
  const newest = nonArchived.at(-1)!
  assert.equal(newest.runs[0].thinking?.length, 6_000)
  const active = nonArchived.find(i => i.id === 'item-1')!
  assert.equal(active.runs[0].thinking?.length, 6_000)
})

test('后续轮次 canvasPrompt 省略重复静态工具教学，但保留画布摘要与上一轮 reviewContext', () => {
  const capture = {
    selectedIds: ['box1'],
    pngBase64: null,
    sceneJson: JSON.stringify({
      elements: [{ id: 'box1', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 }]
    })
  }
  const previous = {
    status: 'rejected' as const,
    review: { verdict: 'rejected' as const, decidedAt: '2026-11-18', note: '间距太窄' }
  }
  const firstPrompt = canvasPrompt('继续调整布局', 'main', capture, previous)
  const followUpPrompt = canvasPrompt('继续调整布局', 'main', capture, previous, { followUp: true })

  assert.match(firstPrompt, /优先用 glob、grep、read_file/)
  assert.doesNotMatch(followUpPrompt, /优先用 glob、grep、read_file/)
  assert.doesNotMatch(followUpPrompt, /不要设 keep_alive/)
  assert.match(followUpPrompt, /沿用本会话已约定的工具与画布规范/)
  assert.match(followUpPrompt, /稳定 ID：box1/)
  assert.match(followUpPrompt, /间距太窄/)
  assert.ok(followUpPrompt.length < firstPrompt.length)
})

test('persist() 在运行中落盘时保留内存里的 run 引用与实时流式草稿，同时磁盘清空 draft/thinkingDraft', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fd-persist-identity-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'agent'), { recursive: true })
  const makeItem = (id: string): AgentWorkItem => ({
    id, board: 'default', cwd: home, sessionId: `s-${id}`, title: id,
    runs: [{ id: `run-${id}`, mode: 'direct', status: 'completed', goal: '目标', startedAt: '2026-11-23', reply: '', draft: '', tools: [], approvals: [] }]
  })
  const seeded = Array.from({ length: KEEP_ITEMS_PER_BOARD }, (_, i) => makeItem(`old-${i}`))
  await writeFile(join(home, 'agent', 'work-items.json'), JSON.stringify({ version: 1, items: seeded }))
  const service = new AgentService({ home, executable: () => { throw new Error('不应启动') }, mcpServers: {} })
  const live = service as unknown as {
    state: { activeItemId: string | null; items: AgentWorkItem[] }
    onEvent(e: unknown): void
    persist(): Promise<void>
  }
  const activeItem = makeItem('work')
  live.state.items.push(activeItem)
  live.state.activeItemId = activeItem.id
  const runRef = activeItem.runs[0]
  runRef.status = 'running'

  // 触发一次淘汰（old-0 被移出）+ 一次无淘汰落盘，均应保留同一个 runRef 和实时草稿
  live.onEvent({ type: 'event', seq: 1, run_id: runRef.id, req: 1, event: 'text_delta', data: { text: '正在输出正文' } })
  live.onEvent({ type: 'event', seq: 2, run_id: runRef.id, req: 1, event: 'thinking_delta', data: { text: '正在思考步骤' } })
  await live.persist()

  assert.equal(live.state.items.length, KEEP_ITEMS_PER_BOARD)
  assert.ok(!live.state.items.some(item => item.id === 'old-0'))
  assert.equal(live.state.items.at(-1)?.runs[0], runRef)
  assert.equal(runRef.draft, '正在输出正文')
  assert.equal(runRef.thinkingDraft, '正在思考步骤')

  live.onEvent({ type: 'event', seq: 3, run_id: runRef.id, req: 1, event: 'text_delta', data: { text: '追加' } })
  live.onEvent({ type: 'event', seq: 4, run_id: runRef.id, req: 1, event: 'thinking_delta', data: { text: '再思考' } })
  await live.persist()

  assert.equal(live.state.items.at(-1)?.runs[0], runRef)
  assert.equal(runRef.draft, '正在输出正文追加')
  assert.equal(runRef.thinkingDraft, '正在思考步骤再思考')

  const saved = JSON.parse(await readFile(join(home, 'agent', 'work-items.json'), 'utf8')).items as AgentWorkItem[]
  const savedRun = saved.at(-1)!.runs[0]
  assert.equal(saved.length, KEEP_ITEMS_PER_BOARD)
  assert.equal(savedRun.draft, '')
  assert.equal(savedRun.thinkingDraft, '')
  await service.close()
})

test('context、request_context、policy 与 run_finished 实时更新 telemetry 与 run.usage，落盘保留并在重置/切换会话时清空', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fd-telemetry-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'agent'), { recursive: true })
  const item: AgentWorkItem = {
    id: 'w1',
    board: 'default',
    cwd: home,
    sessionId: 's1',
    title: '统计用量',
    runs: [{
      id: 'run1',
      mode: 'direct',
      status: 'completed',
      goal: '测试统计',
      startedAt: '2026-11-23',
      reply: '',
      draft: '',
      tools: [],
      approvals: []
    }]
  }
  await writeFile(join(home, 'agent', 'work-items.json'), JSON.stringify({ version: 1, items: [item] }))
  const service = new AgentService({ home, executable: () => { throw new Error('不应启动真实内核') }, mcpServers: {} })
  const live = service as unknown as {
    client: unknown
    state: { activeItemId: string | null; items: AgentWorkItem[] }
    onEvent(e: unknown): void
  }
  live.client = {
    alive: true,
    stop: async () => undefined,
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === 'workspace.open') {
        return { session_id: String(params.session_id ?? 's-fresh'), provider: 'p', model: 'm', setup_needed: false, vision: false, choices: [] }
      }
      return {}
    }
  }
  await service.openTask('w1')
  assert.equal(service.snapshot().telemetry, undefined)

  // 1) context (run_id: null) 初始化上下文与缓存统计
  live.onEvent({
    type: 'event', seq: 1, run_id: null, req: null, event: 'context',
    data: { cache_hit_rate: null, cache_observations: 0, max_tokens: 128_000, total_tokens: 6_400 }
  })
  assert.deepEqual(service.snapshot().telemetry, {
    contextTokens: 6_400,
    contextLimit: 128_000,
    cacheHitRate: null,
    cacheObservations: 0
  })

  // 2) request_context 给出更精确的估算输入，之后的非零 context.total_tokens 不覆盖它
  live.onEvent({
    type: 'event', seq: 2, run_id: 'run1', req: 1, event: 'request_context',
    data: { estimated_input_tokens: 11_700, context_limit: 128_000, request_number: 1 }
  })
  live.onEvent({
    type: 'event', seq: 3, run_id: 'run1', req: 1, event: 'context',
    data: { cache_hit_rate: 0.8, cache_observations: 2, max_tokens: 128_000, total_tokens: 8_000 }
  })
  assert.equal(service.snapshot().telemetry?.contextTokens, 11_700)
  assert.equal(service.snapshot().telemetry?.cacheHitRate, 0.8)
  assert.equal(service.snapshot().telemetry?.cacheObservations, 2)

  // 3) policy 更新消耗、请求数和费用，并同步到 run.usage
  live.onEvent({
    type: 'event', seq: 4, run_id: 'run1', req: 1, event: 'policy',
    data: { requests_used: 2, spent_tokens: 1_200, estimated: false, estimated_cost: 0.015, cost_complete: true }
  })
  assert.equal(service.snapshot().telemetry?.requestsUsed, 2)
  assert.equal(service.snapshot().telemetry?.spentTokens, 1_200)
  assert.equal(service.snapshot().telemetry?.estimatedCost, 0.015)
  assert.deepEqual(service.snapshot().items[0].runs[0].usage, {
    spentTokens: 1_200,
    requestsUsed: 2,
    cacheHitRate: 0.8,
    cacheObservations: 2,
    contextTokens: 11_700,
    contextLimit: 128_000,
    estimatedCost: 0.015
  })

  // 4) run_finished 用 outcome.spent_tokens 校正 run.usage 并落盘
  live.onEvent({
    type: 'event', seq: 5, run_id: 'run1', req: 1, event: 'run_finished',
    data: { outcome: { status: 'completed', spent_tokens: 1_350 } }
  })
  assert.equal(service.snapshot().items[0].runs[0].usage?.spentTokens, 1_350)

  // 5) context.total_tokens === 0 重置 hasRequestContext，使后续非零 total_tokens 生效
  live.onEvent({
    type: 'event', seq: 6, run_id: null, req: null, event: 'context',
    data: { cache_hit_rate: null, cache_observations: 0, max_tokens: 128_000, total_tokens: 0 }
  })
  assert.equal(service.snapshot().telemetry?.contextTokens, 0)
  live.onEvent({
    type: 'event', seq: 7, run_id: null, req: null, event: 'context',
    data: { cache_hit_rate: 0.5, cache_observations: 1, max_tokens: 128_000, total_tokens: 3_200 }
  })
  assert.equal(service.snapshot().telemetry?.contextTokens, 3_200)

  // 6) session_reset 清空 telemetry
  live.onEvent({
    type: 'event', seq: 8, run_id: null, req: null, event: 'session_reset',
    data: { session_id: 's-reset' }
  })
  assert.equal(service.snapshot().telemetry, undefined)

  // 7) 写入 telemetry 后通过 newTask 重新打开工作区，也应清空 telemetry
  live.onEvent({
    type: 'event', seq: 9, run_id: null, req: null, event: 'context',
    data: { cache_hit_rate: 0.6, cache_observations: 3, max_tokens: 128_000, total_tokens: 5_000 }
  })
  assert.ok(service.snapshot().telemetry)
  await service.newTask('default')
  assert.equal(service.snapshot().telemetry, undefined)

  await service.close()
  const saved = JSON.parse(await readFile(join(home, 'agent', 'work-items.json'), 'utf8')) as { items: AgentWorkItem[] }
  assert.deepEqual(saved.items[0].runs[0].usage, {
    spentTokens: 1_350,
    requestsUsed: 2,
    cacheHitRate: 0.8,
    cacheObservations: 2,
    contextTokens: 11_700,
    contextLimit: 128_000,
    estimatedCost: 0.015
  })
})
