import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentService, canvasPrompt } from '../src/main/agent.ts'
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
