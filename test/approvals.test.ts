import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentService, approvalPreview, canvasPrompt } from '../src/main/agent.ts'
import type { AgentWorkItem } from '../src/shared/agent.ts'

// 真实内核给出的审批描述（步骤 ③ 验证里记下的格式）
const describe = (name: string, input: unknown) => [
  `来源：ToolRegistry → 工具 ${name} 的 requires_approval 参数策略`,
  '原因：该工具对当前参数返回 requires_approval=true；控制器沿用工具策略请求本次确认。',
  `操作预览：${name}: ${JSON.stringify(input)}`,
  '作用域：仅此次工具调用；不新增全局/项目允许规则，也不预先批准后续同名操作。',
  '未自动放行：actions 必须省略或为空数组，页面交互需要审批'
].join('\n')

test('审批描述里取出实际参数：只认「操作预览」那一行，没有就不参与记住', () => {
  const input = { command: "cd 'E:\\开发小游戏-验证3'; npm run dev", timeout_secs: 600 }
  assert.equal(approvalPreview('start_job', describe('start_job', input)), JSON.stringify(input))
  assert.equal(approvalPreview('pwsh', '来源：某策略\n原因：需要确认'), undefined)
  assert.equal(approvalPreview('pwsh', '操作预览：'), undefined)
})

test('本任务内都允许：同一调用一字不差才自动批准，参数不同照样询问，清空后恢复询问', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fd-approvals-'))
  try {
    await mkdir(join(home, 'agent'), { recursive: true })
    const item: AgentWorkItem = {
      id: 'w', board: 'default', cwd: home, sessionId: 's', title: 't',
      runs: [{ id: 'r', mode: 'direct', status: 'running', goal: 'g', startedAt: new Date().toISOString(), reply: '', draft: '', tools: [], approvals: [] }]
    }
    await writeFile(join(home, 'agent', 'work-items.json'), JSON.stringify({ version: 1, items: [item] }))
    const service = new AgentService({ home, executable: () => '', mcpServers: {} })
    const sent: { request_id: string; decision: string }[] = []
    const live = service as unknown as {
      state: { busy: boolean; activeItemId: string | null; items: AgentWorkItem[] }
      client: unknown
      onEvent(e: unknown): void
    }
    live.client = { alive: true, stop: async () => undefined, request: async (method: string, params: { request_id: string; decision: string }) => { if (method === 'approval.respond') sent.push(params); return {} } }
    live.state.busy = true
    live.state.activeItemId = 'w'
    live.state.items[0].runs[0].status = 'running'
    let seq = 0
    const ask = (requestId: string, toolId: string, name: string, input: unknown) =>
      live.onEvent({ type: 'event', seq: ++seq, run_id: 'r', req: 1, event: 'approval_request', data: { request_id: requestId, id: toolId, name, description: describe(name, input) } })
    const run = () => service.snapshot().items[0].runs[0]
    const dev = { command: 'npm run dev', timeout_secs: 600 }

    // 第一次：弹给用户，选「本任务内都允许」
    ask('a1', 't1', 'start_job', dev)
    assert.equal(run().approvals[0].answered, false)
    assert.equal(run().approvals[0].preview, JSON.stringify(dev))
    await service.approve('a1', true, true)
    assert.deepEqual(sent.at(-1), { request_id: 'a1', decision: 'approve' })
    assert.deepEqual(service.snapshot().items[0].allowedCommands, [{ name: 'start_job', input: JSON.stringify(dev) }])

    // 同一调用再来：宿主直接批准，不弹卡片，工具记录标「本任务内已允许」
    ask('a2', 't2', 'start_job', dev)
    assert.equal(run().approvals[1].answered, true)
    assert.equal(run().approvals[1].autoApproved, true)
    await new Promise(r => setTimeout(r, 0))
    assert.deepEqual(sent.at(-1), { request_id: 'a2', decision: 'approve' })
    live.onEvent({ type: 'event', seq: ++seq, run_id: 'r', req: 1, event: 'tool_start', data: { id: 't2', name: 'start_job', params_preview: '{}' } })
    assert.equal(run().tools.at(-1)?.autoApproved, 'task_rule')

    // 参数差一点（端口不同）或换了工具：照样询问
    ask('a3', 't3', 'start_job', { command: 'npm run dev -- --port 3000', timeout_secs: 600 })
    ask('a4', 't4', 'pwsh', dev)
    assert.equal(run().approvals[2].answered, false)
    assert.equal(run().approvals[3].answered, false)
    assert.equal(sent.length, 2)
    await service.approve('a3', false)
    await service.approve('a4', true)

    // 没有参数预览的审批不能记住
    live.onEvent({ type: 'event', seq: ++seq, run_id: 'r', req: 1, event: 'approval_request', data: { request_id: 'a5', id: 't5', name: 'pwsh', description: '需要确认' } })
    await assert.rejects(service.approve('a5', true, true), /没法记住/)
    await service.approve('a5', true)

    // 记录随任务落盘；清空后同一调用重新询问
    await service.close().catch(() => undefined)
    const saved = JSON.parse(await readFile(join(home, 'agent', 'work-items.json'), 'utf8')).items[0]
    assert.deepEqual(saved.allowedCommands, [{ name: 'start_job', input: JSON.stringify(dev) }])
    const again = new AgentService({ home, executable: () => '', mcpServers: {} })
    const live2 = again as unknown as typeof live
    live2.client = live.client
    live2.state.busy = true
    live2.state.activeItemId = 'w'
    live2.state.items[0].runs[0].status = 'running'
    await again.clearAllowedCommands()
    assert.equal(again.snapshot().items[0].allowedCommands, undefined)
    live2.onEvent({ type: 'event', seq: 99, run_id: 'r', req: 1, event: 'approval_request', data: { request_id: 'a6', id: 't6', name: 'start_job', description: describe('start_job', dev) } })
    assert.equal(again.snapshot().items[0].runs[0].approvals.at(-1)?.answered, false)
    await again.close().catch(() => undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('提示词告诉模型怎么调用才能被自动放行：截图不带 actions，检查命令不加管道', () => {
  const prompt = canvasPrompt('改一下', 'default', { sceneJson: JSON.stringify({ elements: [] }), pngBase64: null, selectedIds: [] })
  assert.match(prompt, /browser_page[^\n]*不要带 actions[^\n]*wait_ms/)
  assert.match(prompt, /不要加管道、重定向/)
})
