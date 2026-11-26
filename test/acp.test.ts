import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpClient, detectAcpPresetBinary, detectAllAcpPresets, detectAntigravityBinary, resolveAcpCommand, toAcpMcpServers, windowsBatchLaunch } from '../src/main/acpClient.ts'
import { AgentService, type AcpLaunchReview } from '../src/main/agent.ts'
import { acpPlanTarget, type AcpPresetId, type AgentState, type AgentWorkItem } from '../src/shared/agent.ts'

async function createFakeAcpScript(dir: string): Promise<string> {
  const scriptPath = join(dir, 'fake-acp.mjs')
  const code = `
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
let mode = 'default'
let thought = 'high'
let model = 'gemini-4-neon-high'
let permSeq = 0
const pendingPerms = new Map()
let activePrompt = null

function configOptions() {
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] },
    { id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: thought, options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'xhigh', name: 'Extra' }] },
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: mode, options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] }
  ]
}

rl.on('line', line => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.id !== undefined && !msg.method) {
    const waiter = pendingPerms.get(msg.id)
    if (waiter) { pendingPerms.delete(msg.id); waiter(msg.result) }
    return
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.12' },
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { resume: {}, close: {} } }
      }
    })
    return
  }
  if (msg.method === 'session/new' || msg.method === 'session/resume') {
    const seatEnv = msg.params?.mcpServers?.[0]?.env?.find(e => e.name === 'FLYINGDRAWS_SEAT')?.value || ''
    const sid = msg.params?.sessionId || ('acp-sess-' + seatEnv)
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        sessionId: sid,
        models: {
          currentModelId: model,
          availableModels: [
            { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
            { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' }
          ]
        },
        modes: { currentModeId: mode, availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] },
        configOptions: configOptions(),
        _meta: { antigravity: { tier: { name: 'Google AI Pro' } } }
      }
    })
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 1200, size: 1048576 } } })
    return
  }
  if (msg.method === 'session/set_model') {
    model = msg.params.modelId
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
    return
  }
  if (msg.method === 'session/set_mode') {
    mode = msg.params.modeId
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
    return
  }
  if (msg.method === 'session/set_config_option') {
    if (msg.params.configId === 'thought_level') thought = msg.params.value
    if (msg.params.configId === 'mode') mode = msg.params.value
    send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: configOptions() } })
    return
  }
  if (msg.method === 'session/close') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
    return
  }
  if (msg.method === 'session/cancel') {
    if (activePrompt) {
      const p = activePrompt
      activePrompt = null
      send({ jsonrpc: '2.0', id: p.id, result: { stopReason: 'cancelled' } })
    }
    return
  }
  if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId
    const text = (msg.params.prompt || []).filter(b => b.type === 'text').map(b => b.text).join('\\n')
    const hasImage = (msg.params.prompt || []).some(b => b.type === 'image')
    if (text.includes('WAIT_CANCEL')) {
      activePrompt = { id: msg.id, sid }
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '正在思考中…' } } } })
      return
    }
    const askPerm = (toolCallId, title, rawInput) => new Promise(resolve => {
      const rpcId = 'perm-' + (++permSeq)
      pendingPerms.set(rpcId, resolve)
      send({
        jsonrpc: '2.0', id: rpcId, method: 'session/request_permission',
        params: {
          sessionId: sid,
          toolCall: { toolCallId, title, kind: 'execute', rawInput },
          options: [
            { optionId: 'allow_once', name: '允许一次', kind: 'allow_once' },
            { optionId: 'allow_always', name: '始终允许', kind: 'allow_always' },
            { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' }
          ]
        }
      })
    })
    ;(async () => {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先看画布结构。' } } } })
      if (text.includes('NEED_PERM')) {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'run_command', status: 'in_progress', rawInput: { cmd: 'echo hi' } } } })
        const res1 = await askPerm('tc1', 'run_command', { cmd: 'echo hi' })
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: res1?.outcome?.optionId?.startsWith('allow') ? 'completed' : 'failed', rawOutput: 'hi' } } })
        // 第二次相同调用：若用户选了本任务内都允许，将自动放行不弹窗
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'tc2', title: 'run_command', status: 'in_progress', rawInput: { cmd: 'echo hi' } } } })
        const res2 = await askPerm('tc2', 'run_command', { cmd: 'echo hi' })
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc2', status: res2?.outcome?.optionId?.startsWith('allow') ? 'completed' : 'failed', rawOutput: 'hi2' } } })
      }
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP回复：mode=' + mode + ',image=' + hasImage + ',model=' + model } } } })
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 2400, size: 1048576 } } })
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { totalTokens: 320 } } })
    })()
  }
})
`
  await writeFile(scriptPath, code, 'utf8')
  return scriptPath
}

/**
 * 测试用的临时目录：整个文件跑完、各测试的服务都关掉之后才删。
 * node:test 按登记顺序跑 after 钩子，前一个抛错后面的就不跑了。以前每个测试先登记「删目录」、
 * 后登记「关服务」，删目录就跑在关服务前面：服务还开着、快照库还在用时，Windows 上 rmdir 会 EBUSY，
 * 一失败关服务的钩子被跳过，假代理进程留着，测试进程退不出去。
 */
const tempDirs: string[] = []
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
after(async () => {
  for (const dir of tempDirs) {
    // 杀毒软件或索引服务偶尔还占着刚写的文件：重试几次，删不掉只提示，不算测试失败
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      .catch(error => console.warn(`[acp.test] 临时目录没删掉：${dir}（${error instanceof Error ? error.message : String(error)}）`))
  }
})

async function waitFor<T>(check: () => T | null | undefined | false, timeout = 5000, describe?: () => string): Promise<T> {
  const started = Date.now()
  const deadline = started + timeout
  while (Date.now() < deadline) {
    const val = check()
    if (val) return val
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`等待超时（${Date.now() - started} ms）${describe ? `：${describe()}` : ''}`)
}

test('自动探测本地 agy 与自定义路径解析', async t => {
  const root = await tempDir('fd-acp-detect-')
  const localAppData = join(root, 'LocalAppData')
  const agyBin = join(localAppData, 'agy', 'bin', 'agy.exe')
  await mkdir(join(localAppData, 'agy', 'bin'), { recursive: true })
  await writeFile(agyBin, '')

  assert.equal(detectAntigravityBinary({ LOCALAPPDATA: localAppData, PATH: '' }, root, 'win32'), agyBin)
  assert.equal(resolveAcpCommand('', { LOCALAPPDATA: localAppData, PATH: '' }, root, 'win32'), agyBin)
  assert.throws(() => resolveAcpCommand(join(root, 'missing.exe'), { PATH: '' }, root, 'win32'), /找不到配置的 ACP/)

  // 相对路径按当前工作目录解析成绝对路径：确认框、信任指纹和启动用的是同一个文件
  const cwd = process.cwd()
  try {
    process.chdir(localAppData)
    assert.equal(resolveAcpCommand(join('agy', 'bin', 'agy.exe'), { PATH: '' }, root, 'win32'), agyBin)
    process.chdir(root)
    assert.throws(() => resolveAcpCommand(join('agy', 'bin', 'agy.exe'), { PATH: '' }, root, 'win32'), /找不到配置的 ACP/, '换个目录，同一串相对路径不再指向原文件')
    // PATH 里的相对目录不算：同一串相对目录随启动目录指向不同位置
    process.chdir(localAppData)
    assert.throws(() => resolveAcpCommand('agy.exe', { PATH: join('agy', 'bin') }, root, 'win32'), /在 PATH 中找不到/)
    assert.equal(resolveAcpCommand('agy.exe', { PATH: join(localAppData, 'agy', 'bin') }, root, 'win32'), agyBin)
  } finally {
    process.chdir(cwd)
  }

  // 探测全局 npm 目录下的 claude-agent-acp / codex-acp / opencode
  const appData = join(root, 'AppData')
  const npmBin = join(appData, 'npm')
  await mkdir(npmBin, { recursive: true })
  const claudeBin = join(npmBin, 'claude-agent-acp.cmd')
  const codexBin = join(npmBin, 'codex-acp.cmd')
  const opencodeBin = join(npmBin, 'opencode.cmd')
  await writeFile(claudeBin, '')
  await writeFile(codexBin, '')
  await writeFile(opencodeBin, '')
  const fakeEnv = { LOCALAPPDATA: localAppData, APPDATA: appData, PATH: '' }
  assert.equal(detectAcpPresetBinary('claude', fakeEnv, root, 'win32'), claudeBin)
  assert.equal(detectAcpPresetBinary('codex', fakeEnv, root, 'win32'), codexBin)
  assert.equal(detectAcpPresetBinary('opencode', fakeEnv, root, 'win32'), opencodeBin)
  const all = detectAllAcpPresets(fakeEnv, root, 'win32')
  assert.deepEqual(all, { antigravity: agyBin, claude: claudeBin, codex: codexBin, opencode: opencodeBin })
})

test('toAcpMcpServers 正确转换 MCP 配置并按 ACP 席位覆盖 FLYINGDRAWS_SEAT', () => {
  const list = toAcpMcpServers({
    flying_draws: {
      command: '/usr/bin/node',
      args: ['bridge.js'],
      env: { ELECTRON_RUN_AS_NODE: '1', FLYINGDRAWS_SEAT: 'Fuxi' }
    }
  }, '哈吉米')
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'flying_draws')
  assert.deepEqual(list[0].args, ['bridge.js'])
  assert.deepEqual(list[0].env.find(e => e.name === 'FLYINGDRAWS_SEAT'), { name: 'FLYINGDRAWS_SEAT', value: '哈吉米' })
})

test('AgentService 切到 ACP 后端：握手、选模型/思考深度、带图对话、审批记忆、规划执行、取消与持久恢复', async t => {
  const home = await tempDir('fd-acp-service-')
  const fakeScript = await createFakeAcpScript(home)

  const service = new AgentService({
    home,
    executable: () => { throw new Error('ACP 模式下不应启动 Fuxi') },
    acpExecutable: () => process.execPath,
    confirmAcpLaunch: async () => true,
    mcpServers: {
      flying_draws: { command: process.execPath, args: ['bridge.js'], env: { FLYINGDRAWS_SEAT: 'Fuxi' } }
    }
  })
  t.after(() => service.close().catch(() => undefined))

  await service.setEngine('acp', 'default', { command: process.execPath, args: [fakeScript], seat: '哈吉米', label: 'Antigravity' })
  let snap = service.snapshot()
  assert.equal(snap.engine, 'acp')
  assert.equal(snap.seat, '哈吉米')
  assert.equal(snap.connection, 'ready')
  assert.equal(snap.setupNeeded, false)
  assert.equal(snap.vision, true)
  assert.equal(snap.acp?.tier, 'Google AI Pro')
  assert.equal(snap.acp?.version, '1.5.12')
  assert.equal(snap.choices.length, 2)
  assert.equal(snap.choices[0].label, 'Gemini 4 Neon (High)')

  // 切换模型和思考深度
  await service.selectModel('acp', 'gemini-4-neon-xhigh')
  assert.equal(service.snapshot().model, 'gemini-4-neon-xhigh')
  await service.setAcpConfigOption('thought_level', 'xhigh')
  assert.equal(service.snapshot().acp?.configOptions?.find(o => o.id === 'thought_level')?.currentValue, 'xhigh')

  // 带图 + 审批记忆（第一次确认并记住，第二次相同命令自动放行）
  const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
  await service.submit({
    board: 'default',
    goal: 'NEED_PERM 请帮我看看画板',
    mode: 'direct',
    capture: { sceneJson: '{"elements":[]}', selectedIds: [], pngBase64: tinyPng }
  })
  const approval = await waitFor(() => service.snapshot().items[0]?.runs[0]?.approvals.find(a => !a.answered))
  assert.equal(approval.name, 'run_command')
  assert.ok(approval.preview)
  await service.approve(approval.requestId, true, true)

  const doneRun = await waitFor(() => {
    const s = service.snapshot()
    const r = s.items[0]?.runs[0]
    return !s.busy && r && r.status !== 'running' ? r : null
  })
  assert.equal(doneRun.status, 'completed')
  assert.match(doneRun.reply, /ACP回复：mode=default,image=true,model=gemini-4-neon-xhigh/)
  assert.equal(doneRun.thinking, '先看画布结构。')
  assert.equal(doneRun.tools.length, 2)
  assert.equal(doneRun.tools[1].autoApproved, 'task_rule')
  assert.equal(doneRun.usage?.spentTokens, 320)
  assert.equal(service.snapshot().telemetry?.contextTokens, 2400)
  assert.equal(service.snapshot().telemetry?.contextLimit, 1048576)

  // 规划模式 -> 确认执行
  await service.submit({
    board: 'default',
    goal: '帮我先拟个计划',
    mode: 'plan',
    capture: { sceneJson: '{"elements":[]}', selectedIds: [], pngBase64: null }
  })
  const planned = await waitFor(() => {
    const s = service.snapshot()
    const r = s.items[0]?.runs.at(-1)
    return !s.busy && r?.mode === 'plan' && r.status !== 'running' ? r : null
  })
  assert.equal(planned.status, 'planned')
  assert.match(planned.reply, /mode=plan/)

  await service.execute('按这个来')
  const executed = await waitFor(() => {
    const s = service.snapshot()
    const r = s.items[0]?.runs.at(-1)
    return !s.busy && r?.mode === 'execute' && r.status !== 'running' ? r : null
  })
  assert.equal(executed.status, 'completed')
  assert.match(executed.reply, /mode=default/)

  // 取消运行中的 ACP 任务
  await service.submit({
    board: 'default',
    goal: 'WAIT_CANCEL 等我停止',
    mode: 'direct',
    capture: { sceneJson: '{"elements":[]}', selectedIds: [], pngBase64: null }
  })
  await waitFor(() => service.snapshot().busy && service.snapshot().items[0]?.runs.at(-1)?.thinkingDraft)
  await service.cancel()
  const cancelled = await waitFor(() => {
    const s = service.snapshot()
    const r = s.items[0]?.runs.at(-1)
    return !s.busy && r && r.status !== 'running' ? r : null
  })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.thinking, '正在思考中…')

  // YOLO 模式不落盘，但 ACP 引擎和配置会持久恢复
  await service.setApprovalMode('full-access')
  assert.equal(service.snapshot().approvalMode, 'full-access')
  await service.close()

  const reopened = new AgentService({
    home,
    executable: () => { throw new Error('不应启动') },
    acpExecutable: () => process.execPath,
    confirmAcpLaunch: async () => true,
    mcpServers: {}
  })
  t.after(() => reopened.close().catch(() => undefined))
  const restored = reopened.snapshot()
  assert.equal(restored.engine, 'acp')
  assert.equal(restored.seat, '哈吉米')
  assert.equal(restored.acpConfig?.args[0], fakeScript)
  assert.equal(restored.approvalMode, 'auto-safe')
})

test('Claude / OpenCode 风格仅返回 configOptions(model) 与 modes 时也能选模型和切模式，且按预设记席位', async t => {
  const home = await tempDir('fd-acp-config-model-')
  const scriptPath = join(home, 'fake-claude-acp.mjs')
  await writeFile(scriptPath, `
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
let curModel = 'opus'
let curMode = 'auto'
rl.on('line', line => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'Claude Agent ACP', version: '1.0.0' }, agentCapabilities: { promptCapabilities: { image: true } } } })
  } else if (msg.method === 'session/new') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        sessionId: 'claude-s1',
        modes: { currentModeId: curMode, availableModes: [{ id: 'default', name: 'Manual' }, { id: 'auto', name: 'Auto' }, { id: 'plan', name: 'Plan' }] },
        configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: curModel, options: [{ value: 'opus', name: 'Claude Opus' }, { value: 'sonnet', name: 'Claude Sonnet' }] }]
      }
    })
  } else if (msg.method === 'session/set_config_option') {
    if (msg.params.configId === 'model') curModel = msg.params.value
    send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: curModel, options: [{ value: 'opus', name: 'Claude Opus' }, { value: 'sonnet', name: 'Claude Sonnet' }] }] } })
  } else if (msg.method === 'session/set_mode') {
    curMode = msg.params.modeId
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
  }
})
`, 'utf8')

  const service = new AgentService({
    home,
    executable: () => { throw new Error('不应启动 Fuxi') },
    acpExecutable: () => process.execPath,
    confirmAcpLaunch: async () => true,
    mcpServers: {}
  })
  t.after(() => service.close().catch(() => undefined))

  await service.setEngine('acp', 'default', { preset: 'claude', command: process.execPath, args: [scriptPath], seat: '小克' })
  let s = service.snapshot()
  assert.equal(s.acpConfig?.preset, 'claude')
  assert.equal(s.seat, '小克')
  assert.equal(s.model, 'opus')
  assert.equal(s.choices.length, 2)
  assert.equal(s.choices[1].label, 'Claude Sonnet')

  // 通过 configOptions 切模型 & 通过 session/set_mode 切协作模式
  await service.selectModel('acp', 'sonnet')
  assert.equal(service.snapshot().model, 'sonnet')
  await service.setAcpConfigOption('mode', 'plan')
  assert.equal(service.snapshot().acp?.currentModeId, 'plan')

  // 切到 codex 再切回 claude：保留 claude 专属席位「小克」
  await service.setAcpConfig({ preset: 'codex', command: process.execPath, args: [scriptPath], seat: '绯梨' }, 'default')
  assert.equal(service.snapshot().seat, '绯梨')
  await service.setAcpConfig({ preset: 'claude', command: process.execPath, args: [scriptPath] }, 'default')
  assert.equal(service.snapshot().seat, '小克')
})

// ---------- 可编排的假 ACP 代理：收到的每条消息都记进日志，断言代理实际收到了什么 ----------

interface ScriptStep {
  say?: string
  echo?: boolean
  plan?: string[]
  tool?: { toolCallId: string; title?: string; kind?: string; rawInput?: unknown }
  /** sessionId：换成别的会话；null 表示审批请求里不带 sessionId */
  perm?: {
    toolCallId: string; title?: string; kind?: string; rawInput?: unknown; sessionId?: string | null; options?: { optionId: string; name: string; kind: string }[]
    /** 被拒绝时就此结束这一轮，用这个 stopReason（模拟 Claude 收到「继续规划」后中断） */
    stopOnReject?: string
    /** 被允许时代理自己切到这个模式（模拟 Claude 批准计划后退出规划模式） */
    setModeOnAllow?: string
  }
  /** 在会话的工作目录里写文件（模拟代理改项目） */
  write?: { path: string; content: string }
  /** 进程直接退出（模拟代理崩溃） */
  exit?: boolean
  /** 正常回应这一轮之后马上退出 */
  exitAfterTurn?: boolean
  /** 代理自己切模式，并发 current_mode_update / config_option_update */
  setMode?: string
  hang?: boolean
  stop?: string
}
interface FakeConfig {
  caps?: Record<string, unknown>
  authMethods?: { id: string; name: string; description?: string }[]
  authRequired?: boolean
  authMessage?: string
  mode?: string
  modes?: { id: string; name: string }[]
  modeConfig?: string[]
  failSetMode?: string[]
  loadFailTimes?: number
  ignoreCancel?: boolean
  /** 收到 session/cancel 后、回应 prompt 之前再发一条审批请求（模拟取消与审批赛跑） */
  permOnCancel?: { toolCallId: string; title?: string; kind?: string; rawInput?: unknown }
  cases?: Record<string, ScriptStep[]>
}
interface FakeLogEntry {
  argv?: string[]
  exit?: number
  in?: { id?: number | string; method?: string; params?: Record<string, any> }
  permission?: string
  result?: unknown
}

const SCRIPTED_ACP = `
import readline from 'node:readline'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const log = entry => appendFileSync(cfg.log, JSON.stringify(entry) + '\\n')
log({ argv: process.argv.slice(3) })
process.on('exit', () => log({ exit: process.pid }))
const send = obj => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\\n')
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } })
let mode = cfg.mode || 'default'
let seq = 0
let loads = 0
let permSeq = 0
let active = null
const waiters = new Map()
const cwds = new Map()
const modeOptions = () => cfg.modeConfig ? [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: mode, options: cfg.modeConfig.map(v => ({ value: v, name: v })) }] : undefined
const session = sessionId => ({
  sessionId,
  ...(cfg.modes ? { modes: { currentModeId: mode, availableModes: cfg.modes } } : {}),
  ...(cfg.modeConfig ? { configOptions: modeOptions() } : {})
})
const DEFAULT_OPTIONS = [
  { optionId: 'once', name: '允许一次', kind: 'allow_once' },
  { optionId: 'always', name: '始终允许', kind: 'allow_always' },
  { optionId: 'no', name: '拒绝', kind: 'reject_once' }
]
async function runPrompt(msg) {
  const sid = msg.params.sessionId
  const blocks = msg.params.prompt || []
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\\n')
  const name = Object.keys(cfg.cases || {}).find(k => text.includes(k))
  const steps = name ? cfg.cases[name] : [{ echo: true }]
  let stop = 'end_turn'
  let exitAfter = false
  for (const step of steps) {
    if (step.exitAfterTurn) exitAfter = true
    if (step.say) update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.say } })
    if (step.echo) update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'mode=' + mode + ';images=' + blocks.filter(b => b.type === 'image').length } })
    if (step.plan) update(sid, { sessionUpdate: 'plan', entries: step.plan.map(content => ({ content, status: 'pending', priority: 'medium' })) })
    if (step.tool) update(sid, { sessionUpdate: 'tool_call', status: 'in_progress', ...step.tool })
    if (step.setMode) {
      mode = step.setMode
      update(sid, { sessionUpdate: 'current_mode_update', currentModeId: mode })
      if (cfg.modeConfig) update(sid, { sessionUpdate: 'config_option_update', configOptions: modeOptions() })
    }
    if (step.perm) {
      const { options, sessionId: permSid, stopOnReject, setModeOnAllow, ...toolCall } = step.perm
      update(sid, { sessionUpdate: 'tool_call', status: 'pending', ...toolCall })
      const rpcId = 'perm-' + (++permSeq)
      const result = await new Promise(resolve => {
        waiters.set(rpcId, resolve)
        send({ id: rpcId, method: 'session/request_permission', params: { ...(permSid === null ? {} : { sessionId: permSid || sid }), toolCall, options: options || DEFAULT_OPTIONS } })
      })
      const outcome = (result && result.outcome) || {}
      log({ permission: toolCall.toolCallId, result: outcome })
      if (outcome.outcome === 'cancelled') { stop = 'cancelled'; break }
      const allowed = outcome.outcome === 'selected' && outcome.optionId !== 'no'
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: toolCall.toolCallId, status: allowed ? 'completed' : 'failed', rawOutput: allowed ? 'done' : 'rejected' })
      if (allowed && setModeOnAllow) { mode = setModeOnAllow; update(sid, { sessionUpdate: 'current_mode_update', currentModeId: mode }) }
      if (!allowed && stopOnReject) { stop = stopOnReject; break }
    }
    if (step.write) writeFileSync(join(cwds.get(sid) || process.cwd(), step.write.path), step.write.content)
    if (step.exit) { setTimeout(() => process.exit(3), 100); return }
    if (step.hang) { active = msg.id; return }
    if (step.stop) stop = step.stop
  }
  send({ id: msg.id, result: { stopReason: stop } })
  if (exitAfter) setTimeout(() => process.exit(4), 50)
}
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  log({ in: msg })
  if (msg.id !== undefined && !msg.method) {
    const w = waiters.get(msg.id)
    if (w) { waiters.delete(msg.id); w(msg.result) }
    return
  }
  const reply = result => send({ id: msg.id, result })
  const fail = message => send({ id: msg.id, error: { code: -32603, message } })
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: 1, agentInfo: { name: 'Fake ACP', version: '0.0.1' }, agentCapabilities: cfg.caps || {}, authMethods: cfg.authMethods || [] })
    case 'session/new': {
      if (cfg.authRequired) return send({ id: msg.id, error: { code: -32000, message: cfg.authMessage || 'Authentication required' } })
      const sid = 's-' + (++seq)
      cwds.set(sid, msg.params.cwd)
      return reply(session(sid))
    }
    case 'session/load':
    case 'session/resume':
      loads++
      if (cfg.loadFailTimes && loads <= cfg.loadFailTimes) return fail('history unavailable')
      return reply(session(msg.params.sessionId))
    case 'session/set_mode':
      if ((cfg.failSetMode || []).includes(msg.params.modeId)) return fail('mode locked')
      mode = msg.params.modeId
      return reply({})
    case 'session/set_config_option':
      if (msg.params.configId === 'mode' && (cfg.failSetMode || []).includes(msg.params.value)) return fail('mode locked')
      if (msg.params.configId === 'mode') mode = msg.params.value
      return reply({ configOptions: modeOptions() || [] })
    case 'session/cancel': {
      if (!active) return
      const id = active
      active = null
      if (cfg.permOnCancel) {
        const toolCall = cfg.permOnCancel
        const rpcId = 'perm-' + (++permSeq)
        new Promise(resolve => {
          waiters.set(rpcId, resolve)
          send({ id: rpcId, method: 'session/request_permission', params: { sessionId: msg.params.sessionId, toolCall, options: DEFAULT_OPTIONS } })
        }).then(result => {
          log({ permission: toolCall.toolCallId, result: (result && result.outcome) || {} })
          send({ id, result: { stopReason: 'cancelled' } })
        })
        return
      }
      if (cfg.ignoreCancel) {
        setTimeout(() => {
          update(msg.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LATE' } })
          send({ id, result: { stopReason: 'cancelled' } })
        }, 1500)
        return
      }
      return send({ id, result: { stopReason: 'cancelled' } })
    }
    case 'session/prompt':
      void runPrompt(msg)
      return
    default:
      if (msg.id !== undefined) reply({})
  }
})
`

async function scriptedAcp(dir: string, cfg: FakeConfig) {
  await mkdir(dir, { recursive: true })
  const script = join(dir, 'scripted-acp.mjs')
  const cfgPath = join(dir, 'fake.json')
  const logPath = join(dir, 'fake.log')
  await writeFile(script, SCRIPTED_ACP, 'utf8')
  await writeFile(cfgPath, JSON.stringify({ ...cfg, log: logPath }), 'utf8')
  await writeFile(logPath, '', 'utf8')
  const entries = async (): Promise<FakeLogEntry[]> =>
    (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as FakeLogEntry)
  const received = async (method: string) => (await entries()).filter(e => e.in?.method === method).map(e => e.in!)
  const choices = async () => (await entries()).filter(e => e.permission).map(e => e.result)
  return { dir, script, cfgPath, logPath, entries, received, choices }
}
type ScriptedAcp = Awaited<ReturnType<typeof scriptedAcp>>

/** 不带参数也能启动假代理的启动器，用来模拟内置预设（自动探测命令 + 默认参数）。 */
async function fakeLauncher(fake: ScriptedAcp): Promise<string> {
  if (process.platform === 'win32') {
    const path = join(fake.dir, 'run acp.cmd')
    await writeFile(path, `@"${process.execPath}" "%~dp0scripted-acp.mjs" "%~dp0fake.json" %*\r\n`, 'utf8')
    return path
  }
  const path = join(fake.dir, 'run-acp.sh')
  await writeFile(path, `#!/bin/sh\nexec "${process.execPath}" "${fake.script}" "${fake.cfgPath}" "$@"\n`, 'utf8')
  await chmod(path, 0o755)
  return path
}

function makeService(home: string, command: string, opts: { confirm?: (launch: AcpLaunchReview) => Promise<boolean>; grace?: number } = {}) {
  return new AgentService({
    home,
    executable: () => { throw new Error('ACP 模式下不应启动 Fuxi') },
    acpExecutable: () => command,
    confirmAcpLaunch: opts.confirm ?? (async () => true),
    ...(opts.grace ? { acpCancelGraceMs: opts.grace } : {}),
    mcpServers: {}
  })
}
const connectFake = (service: AgentService, fake: ScriptedAcp) =>
  service.setEngine('acp', 'default', { preset: 'custom', command: process.execPath, args: [fake.script, fake.cfgPath], seat: 'Fake', label: 'Fake' })
const emptyCapture = (png: string | null = null) => ({ sceneJson: '{"elements":[]}', selectedIds: [] as string[], pngBase64: png })
const ask = (service: AgentService, goal: string, mode: 'direct' | 'plan' = 'direct') =>
  service.submit({ board: 'default', goal, mode, capture: emptyCapture() })
const lastRun = (service: AgentService) => {
  const snap = service.snapshot()
  return snap.items.find(item => item.id === snap.activeItemId)?.runs.at(-1)
}
/** 等待超时时说明服务当时停在哪：连接、busy、最后一轮的状态、审批和工具 */
const serviceState = (service: AgentService) => {
  const snap = service.snapshot()
  const run = lastRun(service)
  return [
    `connection=${snap.connection}`, `busy=${snap.busy}`, `run=${run?.goal ?? '-'}/${run?.status ?? '-'}`,
    `approvals=[${run?.approvals.map(a => `${a.name}:${a.answered ? 'answered' : 'pending'}`).join(', ') ?? ''}]`,
    `tools=[${run?.tools.map(tool => `${tool.id}:${tool.status}`).join(', ') ?? ''}]`,
    `error=${snap.error ?? ''}`
  ].join(' ')
}
const settle = (service: AgentService) => waitFor(() => {
  const run = lastRun(service)
  return !service.snapshot().busy && run && run.status !== 'running' ? run : null
}, undefined, () => `本轮没有结束 ${serviceState(service)}`)
const pendingApproval = (service: AgentService, skip: string[] = []) =>
  waitFor(() => lastRun(service)?.approvals.find(a => !a.answered && !skip.includes(a.requestId)), undefined, () => `没等到新的审批 ${serviceState(service)}`)

test('ACP 审批：两种允许都只选「允许一次」；本任务规则按完整参数匹配，清空或另开任务后重新询问；只给永久授权时单次允许选不中它', async t => {
  const home = await tempDir('fd-acp-perm-')
  const big = 'x'.repeat(9000)
  const write = (id: string, tail: string): ScriptStep => ({ perm: { toolCallId: id, title: 'write_file', kind: 'edit', rawInput: { path: 'a.txt', content: big + tail } } })
  const permanentOnly: ScriptStep = { perm: {
    toolCallId: 'p1', title: 'run', kind: 'execute', rawInput: { cmd: 'ls' },
    options: [{ optionId: 'always', name: '始终允许', kind: 'allow_always' }, { optionId: 'no', name: '拒绝', kind: 'reject_once' }]
  } }
  const fake = await scriptedAcp(join(home, 'fake'), {
    cases: {
      TWICE: [write('w1', 'END'), write('w2', 'END'), write('w3', 'OTHER'), { say: '写完了' }],
      ONCE: [write('w4', 'END'), { say: 'ok' }],
      PERMANENT: [permanentOnly, { say: 'ok' }]
    }
  })
  const service = makeService(join(home, 'app'), process.execPath)
  t.after(() => service.close().catch(() => undefined))
  await connectFake(service, fake)

  await ask(service, 'TWICE')
  const first = await pendingApproval(service)
  assert.ok(first.ruleKey, '有完整参数时给出匹配键')
  await service.approve(first.requestId, true, true)
  // 第二次参数完全相同：宿主自动放行；第三次前 8000 字符相同、末尾不同：照样询问
  const third = await pendingApproval(service, [first.requestId])
  assert.equal(lastRun(service)!.approvals[1].autoApproved, true)
  assert.equal(third.preview, first.preview, '预览只有前 8000 字符，看上去一模一样')
  assert.notEqual(third.ruleKey, first.ruleKey)
  await service.approve(third.requestId, true)
  const twice = await settle(service)
  assert.equal(twice.tools.find(tool => tool.id === 'w2')?.autoApproved, 'task_rule')
  const once = { outcome: 'selected', optionId: 'once' }
  assert.deepEqual(await fake.choices(), [once, once, once], '本次允许、本任务内都允许、自动放行都只选 allow_once')

  // 清空本任务规则后，同一调用重新询问
  await service.clearAllowedCommands()
  await ask(service, 'ONCE')
  await service.approve((await pendingApproval(service)).requestId, true, true)
  await settle(service)

  // 另开新任务：规则不跟过去
  await service.newTask('default')
  await ask(service, 'ONCE')
  const fresh = await pendingApproval(service)
  await service.approve(fresh.requestId, true)
  await settle(service)

  // 旧版 ACP 规则只有展示用的预览、没有完整参数的匹配键：首次重遇照样询问
  const live = service as unknown as { state: { items: AgentWorkItem[]; activeItemId: string | null } }
  live.state.items.find(item => item.id === live.state.activeItemId)!.allowedCommands = [{ name: 'write_file', input: fresh.preview! }]
  await ask(service, 'ONCE')
  const legacy = await pendingApproval(service)
  assert.equal((await fake.choices()).length, 5, '旧规则没有替用户放行')
  await service.approve(legacy.requestId, false)
  await settle(service)

  // 只给永久授权：「本次允许」「本任务内都允许」都不会选中它，用户明确点「始终允许」才选
  await ask(service, 'PERMANENT')
  const permanent = await pendingApproval(service)
  await assert.rejects(service.approve(permanent.requestId, true), /只提供永久授权/)
  await assert.rejects(service.approve(permanent.requestId, true, true), /只提供永久授权/)
  assert.equal((await fake.choices()).length, 6, '两次被拒的点击都没有替用户回应代理')
  await service.approve(permanent.requestId, true, false, true)
  await settle(service)

  // YOLO 也只替用户选「允许一次」；只有永久授权时照样弹给用户
  await service.setApprovalMode('full-access')
  await ask(service, 'ONCE')
  await settle(service)
  await ask(service, 'PERMANENT')
  await service.approve((await pendingApproval(service)).requestId, false)
  await settle(service)
  await service.setApprovalMode('auto-safe')

  assert.deepEqual((await fake.choices()).slice(3), [
    once,
    once,
    { outcome: 'selected', optionId: 'no' },
    { outcome: 'selected', optionId: 'always' },
    once,
    { outcome: 'selected', optionId: 'no' }
  ])
})

test('ACP 规划：configOptions 和 modes 两种表示都走通「拟计划 → 确认执行」，执行前恢复进入规划前的模式', async t => {
  const home = await tempDir('fd-acp-plan-')
  const variants = [
    { name: 'config', cfg: { modeConfig: ['default', 'plan'], mode: 'default' }, method: 'session/set_config_option', original: 'default' },
    { name: 'modes', cfg: { modes: [{ id: 'code', name: 'Code' }, { id: 'plan', name: 'Plan' }], mode: 'code' }, method: 'session/set_mode', original: 'code' }
  ]
  for (const variant of variants) {
    const fake = await scriptedAcp(join(home, variant.name), { ...variant.cfg, cases: { PLAN_IT: [{ plan: ['读画布', '整理结构'] }, { echo: true }] } })
    const service = makeService(join(home, `${variant.name}-app`), process.execPath)
    try {
      await connectFake(service, fake)
      assert.ok(acpPlanTarget(service.snapshot().acp), `${variant.name}：识别出规划能力`)
      await ask(service, 'PLAN_IT', 'plan')
      const planned = await settle(service)
      assert.equal(planned.status, 'planned')
      assert.match(planned.reply, /mode=plan/)
      assert.match(planned.plan ?? '', /读画布/)
      await service.execute('')
      const executed = await settle(service)
      assert.equal(executed.mode, 'execute')
      assert.equal(executed.status, 'completed')
      assert.match(executed.reply, new RegExp(`mode=${variant.original};`))
      // 切模式的请求排在对应那次 session/prompt 之前
      const order = (await fake.entries())
        .filter(e => e.in?.method === variant.method || e.in?.method === 'session/prompt')
        .map(e => e.in!.method === 'session/prompt' ? 'prompt' : String(e.in!.params?.modeId ?? e.in!.params?.value))
      assert.deepEqual(order, ['plan', 'prompt', variant.original, 'prompt'])
    } finally {
      await service.close()
    }
  }
})

test('ACP 规划：生成计划后用户改选的模式在确认执行时生效；代理自己退出规划后不被切回规划前的模式', async t => {
  const home = await tempDir('fd-acp-plan-mode-')
  const fake = await scriptedAcp(join(home, 'fake'), {
    modeConfig: ['fast', 'manual', 'plan'],
    mode: 'fast',
    cases: {
      PLAN_IT: [{ plan: ['读画布'] }, { echo: true }],
      PLAN_EXIT: [{ plan: ['读画布'] }, { setMode: 'fast' }, { echo: true }]
    }
  })
  const service = makeService(join(home, 'app'), process.execPath)
  t.after(() => service.close().catch(() => undefined))
  await connectFake(service, fake)

  // 从 fast 拟计划，生成后用户改选 manual：确认执行就按 manual，不切回 fast
  await ask(service, 'PLAN_IT', 'plan')
  assert.equal((await settle(service)).status, 'planned')
  await service.setAcpConfigOption('mode', 'manual')
  await service.execute('')
  const executed = await settle(service)
  assert.equal(executed.status, 'completed')
  assert.match(executed.reply, /mode=manual;/, '用户最后选的模式生效')

  // 从 manual 拟计划，代理在规划中自己切到 fast：确认执行以代理当前模式为准，不再切回 manual
  await ask(service, 'PLAN_EXIT', 'plan')
  assert.equal((await settle(service)).status, 'planned')
  assert.equal(service.snapshot().acp?.currentModeId, 'fast')
  await service.execute('')
  assert.match((await settle(service)).reply, /mode=fast;/)

  const switches = (await fake.received('session/set_config_option')).map(m => m.params?.value)
  assert.deepEqual(switches, ['plan', 'manual', 'plan'], '宿主没有在确认执行前替用户改模式')
})

test('ACP 规划：代理用空列表撤回全部步骤后，旧步骤不再显示、也不能凭旧步骤确认执行', async t => {
  const home = await tempDir('fd-acp-plan-clear-')
  const fake = await scriptedAcp(join(home, 'fake'), {
    modeConfig: ['default', 'plan'],
    cases: {
      WITHDRAW_SILENT: [{ plan: ['改掉 a.txt'] }, { plan: [] }],
      WITHDRAW_SAY: [{ plan: ['改掉 a.txt'] }, { plan: [] }, { say: '看过了，不需要改动。' }],
      REPLACE: [{ plan: ['旧步骤'] }, { plan: ['新步骤一', '新步骤二'] }],
      RESET_FIRST: [{ plan: [] }, { say: '整理成三步：读、改、验。' }]
    }
  })
  const service = makeService(join(home, 'app'), process.execPath)
  t.after(() => service.close().catch(() => undefined))
  await connectFake(service, fake)

  await ask(service, 'WITHDRAW_SILENT', 'plan')
  const silent = await settle(service)
  assert.equal(silent.status, 'failed', '没有任何计划内容，不能确认执行')
  assert.equal(silent.plan, undefined)
  await assert.rejects(service.execute(''), /没有等待确认的计划/)

  await ask(service, 'WITHDRAW_SAY', 'plan')
  const said = await settle(service)
  assert.equal(said.status, 'failed', '撤回了全部步骤，回复只是说明，不能当计划确认执行')
  assert.equal(said.plan, undefined, '撤回的步骤不再出现在计划里')
  assert.match(said.reply, /不需要改动/, '回复照常保留')
  assert.match(said.error ?? '', /撤回了全部计划步骤/)
  await assert.rejects(service.execute(''), /没有等待确认的计划/)

  await ask(service, 'REPLACE', 'plan')
  const replaced = await settle(service)
  assert.equal(replaced.plan, '- [ ] 新步骤一\n- [ ] 新步骤二', '每次更新整体替换')

  // 一开始就发空列表只是清空，不算撤回：回复正文照常当计划
  await ask(service, 'RESET_FIRST', 'plan')
  const reset = await settle(service)
  assert.equal(reset.status, 'planned')
  assert.match(reset.plan ?? '', /整理成三步/)
})

test('ACP 停止：代理回应取消前又来的审批一律答 cancelled，YOLO 也不放行；其他会话的审批同样不放行', async t => {
  const home = await tempDir('fd-acp-cancel-perm-')
  const fake = await scriptedAcp(join(home, 'fake'), {
    permOnCancel: { toolCallId: 'late', title: 'run', kind: 'execute', rawInput: { cmd: 'rm -rf build' } },
    cases: {
      HANG_IT: [{ say: '处理中' }, { hang: true }],
      OTHER_SESSION: [{ perm: { toolCallId: 'x1', title: 'run', kind: 'execute', rawInput: { cmd: 'ls' }, sessionId: 'someone-else' } }, { say: 'ok' }],
      NO_SESSION: [{ perm: { toolCallId: 'x2', title: 'run', kind: 'execute', rawInput: { cmd: 'ls' }, sessionId: null } }, { say: 'ok' }]
    }
  })
  const service = makeService(join(home, 'app'), process.execPath)
  t.after(() => service.close().catch(() => undefined))
  await connectFake(service, fake)
  await service.setApprovalMode('full-access')

  await ask(service, 'HANG_IT')
  await waitFor(() => lastRun(service)?.draft)
  await service.cancel()
  const stopped = await settle(service)
  assert.equal(stopped.status, 'cancelled')
  assert.deepEqual(await fake.choices(), [{ outcome: 'cancelled' }], '停止后迟到的审批没有被 YOLO 放行')
  assert.equal(stopped.approvals.length, 0, '停止后不再弹审批卡')
  assert.equal(stopped.tools.find(tool => tool.id === 'late')?.autoApproved, undefined)

  await ask(service, 'OTHER_SESSION')
  await settle(service)
  assert.deepEqual((await fake.choices()).at(-1), { outcome: 'cancelled' }, '不是当前会话的审批不放行')

  await ask(service, 'NO_SESSION')
  await settle(service)
  assert.deepEqual((await fake.choices()).at(-1), { outcome: 'cancelled' }, '没带 sessionId 的审批不放行')
})

test('ACP 审批：工具身份和参数分开发送时按各自身份匹配许可；身份不明时只能单次允许', async t => {
  const home = await tempDir('fd-acp-perm-split-')
  const same = { path: 'notes.txt' }
  const fake = await scriptedAcp(join(home, 'fake'), {
    cases: {
      SPLIT: [
        { tool: { toolCallId: 'a1', title: 'read_file', kind: 'read' } },
        { perm: { toolCallId: 'a1', rawInput: same } },
        { tool: { toolCallId: 'a2', title: 'delete_file', kind: 'delete' } },
        { perm: { toolCallId: 'a2', rawInput: same } },
        { say: 'ok' }
      ],
      ANON: [{ perm: { toolCallId: 'z1', rawInput: same } }, { say: 'ok' }],
      KIND_ONLY: [{ perm: { toolCallId: 'k1', kind: 'execute', rawInput: same } }, { say: 'ok' }]
    }
  })
  const service = makeService(join(home, 'app'), process.execPath)
  t.after(() => service.close().catch(() => undefined))
  await connectFake(service, fake)

  await ask(service, 'SPLIT')
  const read = await pendingApproval(service)
  assert.equal(read.name, 'read_file', '审批卡用先前通知里的工具标题')
  assert.ok(read.ruleKey)
  await service.approve(read.requestId, true, true)
  const del = await pendingApproval(service, [read.requestId])
  assert.equal(del.name, 'delete_file')
  assert.notEqual(del.ruleKey, read.ruleKey, '参数相同但工具不同，许可不复用')
  await service.approve(del.requestId, false)
  await settle(service)

  await ask(service, 'ANON')
  const anon = await pendingApproval(service)
  assert.equal(anon.ruleKey, undefined, '不知道是哪个工具时不给匹配键')
  await assert.rejects(service.approve(anon.requestId, true, true), /没法记住/)
  await service.approve(anon.requestId, true)
  await settle(service)
  const once = { outcome: 'selected', optionId: 'once' }
  assert.deepEqual(await fake.choices(), [once, { outcome: 'selected', optionId: 'no' }, once])

  // 只有工具类别、没有工具标题：类别不是身份，同样只能单次允许
  await ask(service, 'KIND_ONLY')
  const kindOnly = await pendingApproval(service)
  assert.equal(kindOnly.ruleKey, undefined)
  await assert.rejects(service.approve(kindOnly.requestId, true, true), /没法记住/)
  await service.approve(kindOnly.requestId, true)
  await settle(service)
})

test('ACP 历史任务：工作目录移走后主动打开仍显示原记录，只读，不能接着发', async t => {
  const home = await tempDir('fd-acp-missing-cwd-')
  const project = join(home, 'project')
  await mkdir(project, { recursive: true })
  const fake = await scriptedAcp(join(home, 'fake'), { caps: { loadSession: true } })
  const service = makeService(join(home, 'app'), process.execPath)
  t.after(() => service.close().catch(() => undefined))
  await connectFake(service, fake)
  await service.setWorkspace('default', project)
  await ask(service, '第一轮')
  await settle(service)
  const original = service.snapshot().items.find(item => item.runs.length)!
  assert.ok(original)

  await service.newTask('default')
  await rm(project, { recursive: true, force: true })
  await service.openTask(original.id)
  const snap = service.snapshot()
  assert.equal(snap.activeItemId, original.id, '选中的历史任务照常显示')
  assert.equal(snap.readOnlyTask?.itemId, original.id)
  assert.match(snap.readOnlyTask?.message ?? '', /工作目录已不存在/)
  assert.equal(snap.acpResume, undefined)
  assert.equal(snap.items.find(item => item.id === original.id)?.runs.length, 1)
  assert.equal(snap.items.find(item => item.id === original.id)?.sessionId, original.sessionId, '原会话 ID 没被换掉')
  await assert.rejects(ask(service, '接着做'), /只能查看/)
  assert.equal((await fake.received('session/load')).length, 0, '没有在别的目录里接着原会话')

  // 开始新任务：回到应用专用目录，正常可用
  await service.newTask('default')
  assert.equal(service.snapshot().readOnlyTask, undefined)
  await ask(service, '新的一项')
  assert.equal((await settle(service)).status, 'completed')
})

test('ACP 中途退出：已收到的回复保留并落盘，本轮改动快照照常结算，结算完才放开下一轮', async t => {
  const home = await tempDir('fd-acp-crash-')
  const project = join(home, 'project')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'keep.txt'), 'old\n')
  const fake = await scriptedAcp(join(home, 'fake'), {
    caps: { loadSession: true },
    cases: { CRASH_IT: [{ write: { path: 'crash.txt', content: '中断前写入\n' } }, { say: '已写入中断前的文件' }, { exit: true }] }
  })
  const appHome = join(home, 'app')
  const service = makeService(appHome, process.execPath)
  t.after(() => service.close().catch(() => undefined))
  await connectFake(service, fake)
  await service.setWorkspace('default', project)
  // 第一次收到 busy=false 的状态通知时，磁盘上的记录必须已经是最终结果
  const recordsPath = join(appHome, 'agent', 'work-items.json')
  let sawBusy = false
  let diskAtRelease: AgentWorkItem[] | null = null
  service.on('state', (snap: AgentState) => {
    if (snap.busy) sawBusy = true
    else if (sawBusy && !diskAtRelease) diskAtRelease = JSON.parse(readFileSync(recordsPath, 'utf8')).items as AgentWorkItem[]
  })

  await ask(service, 'CRASH_IT')
  const run = await settle(service)
  assert.equal(run.status, 'interrupted')
  assert.match(run.reply, /已写入中断前的文件/, '已收到的回复并入正文')
  assert.ok(run.roundChanges, '本轮改动快照已结算')
  assert.deepEqual(run.roundChanges!.files.map(file => file.path), ['crash.txt'])
  assert.match(await service.roundDiff(run.id), /中断前写入/)
  assert.equal(service.snapshot().connection, 'offline')

  // 放开任务那一刻，磁盘上的记录里已经有这句回复和改动（重新打开记录、应用异常退出都不会丢）
  assert.ok(diskAtRelease, '收到了放开任务的状态通知')
  const savedRun = diskAtRelease!.flatMap(item => item.runs).find(r => r.id === run.id)!
  assert.equal(savedRun.status, 'interrupted')
  assert.match(savedRun.reply, /已写入中断前的文件/)
  assert.ok(savedRun.roundChanges)

  // 重新连接后接着原任务：选中的仍是这项任务
  await ask(service, '接着做')
  const next = await settle(service)
  assert.equal(next.status, 'completed')
  assert.equal(service.snapshot().items.find(item => item.runs.some(r => r.id === run.id))?.runs.length, 2, '重连后接着用户选中的原任务')
})

test('ACP 历史任务：代理启动不了时也能选中并查看本机记录；工作目录不在的任务直接只读，不必连接代理', async t => {
  const home = await tempDir('fd-acp-offline-history-')
  const kept = join(home, 'kept')
  const moved = join(home, 'moved')
  await mkdir(kept, { recursive: true })
  await mkdir(moved, { recursive: true })
  const fake = await scriptedAcp(join(home, 'fake'), { caps: { loadSession: true } })
  const appHome = join(home, 'app')
  const first = makeService(appHome, process.execPath)
  await connectFake(first, fake)
  await first.setWorkspace('default', kept)
  await ask(first, '第一项')
  await settle(first)
  await first.setWorkspace('default', moved)
  await ask(first, '第二项')
  await settle(first)
  const [keptItem, movedItem] = first.snapshot().items
  await first.close()
  await rm(moved, { recursive: true, force: true })

  // 代理程序已经卸载：启动必然失败
  const second = makeService(appHome, join(home, 'uninstalled', 'agent.exe'))
  t.after(() => second.close().catch(() => undefined))
  await assert.rejects(second.openTask(keptItem.id))
  let snap = second.snapshot()
  assert.equal(snap.activeItemId, keptItem.id, '连不上代理也选中了这项任务')
  assert.match(snap.items.find(item => item.id === keptItem.id)?.runs[0].reply ?? '', /mode=/, '本机记录照常可看')
  assert.notEqual(snap.connection, 'ready')

  await second.openTask(movedItem.id)
  snap = second.snapshot()
  assert.equal(snap.activeItemId, movedItem.id)
  assert.equal(snap.readOnlyTask?.itemId, movedItem.id, '工作目录不在：直接只读查看')
  assert.equal(snap.connection, 'offline', '没有为只读查看启动代理')
  await assert.rejects(ask(second, '接着做'), /只能查看/)
})

test('ACP 强停失败：旧进程还活着时不自动重连、也不启动新代理；它退出后才能重新连接', async t => {
  const home = await tempDir('fd-acp-stuck-')
  const fake = await scriptedAcp(join(home, 'fake'), { cases: { STUCK_IT: [{ say: '开始' }, { hang: true }] } })
  const service = makeService(join(home, 'app'), process.execPath, { grace: 150 })
  t.after(() => service.close().catch(() => undefined))
  await connectFake(service, fake)

  await ask(service, 'STUCK_IT')
  await waitFor(() => lastRun(service)?.draft)
  // 让这次强停“失败”：进程照样活着
  const live = service as unknown as { acpClient: AcpClient }
  const old = live.acpClient
  const realStop = old.stop.bind(old)
  old.stop = async () => false
  t.after(() => realStop().catch(() => undefined))
  // 代理不回应取消：假代理在这一轮里不理会 session/cancel
  ;(old as unknown as { cancelSession: (sid: string) => void }).cancelSession = () => undefined
  await service.cancel()
  const stopped = await settle(service)
  assert.equal(stopped.status, 'cancelled')
  assert.match(stopped.error ?? '', /强制结束也没有成功/)
  assert.equal(service.snapshot().connection, 'error')
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal((await fake.received('initialize')).length, 1, '没有自动启动新代理')
  await assert.rejects(ask(service, '下一轮'), /还在运行/)
  assert.equal((await fake.received('initialize')).length, 1)
  // 从设置里保存同一份配置重连：同样拦住，不启动第二个代理
  await assert.rejects(
    service.setAcpConfig({ preset: 'custom', command: process.execPath, args: [fake.script, fake.cfgPath], seat: 'Fake', label: 'Fake' }, 'default'),
    /还在运行/
  )
  assert.equal((await fake.received('initialize')).length, 1, '保存设置后重连也没有启动第二个代理')
  assert.equal(old.alive, true)

  // 旧进程退出后可以重新连接
  assert.equal(await realStop(), true)
  await waitFor(() => !old.alive)
  await ask(service, '下一轮')
  assert.equal((await settle(service)).status, 'completed')
  assert.equal((await fake.received('initialize')).length, 2)
})

test('ACP 收尾期间连接断开：收尾认领这一轮、按代理的结果结束，结算完才放开任务，不会清掉下一轮', async t => {
  const home = await tempDir('fd-acp-finish-race-')
  const fake = await scriptedAcp(join(home, 'fake'), { cases: { DONE_THEN_EXIT: [{ say: '做完了' }, { exitAfterTurn: true }] } })
  const service = makeService(join(home, 'app'), process.execPath)
  t.after(() => service.close().catch(() => undefined))
  await connectFake(service, fake)

  // 卡住第一轮的快照结算：代理在这期间退出
  const live = service as unknown as { finishBaseline(run: unknown): Promise<void> }
  const realFinish = live.finishBaseline.bind(service)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let gated = 0
  // 只卡住第一轮收尾自己的那次结算；别处再发起的结算照常进行（复现断线处理抢先放开任务）
  live.finishBaseline = async run => { gated++; if (gated === 1) await gate; return realFinish(run) }
  await ask(service, 'DONE_THEN_EXIT')
  await waitFor(() => gated > 0)
  await waitFor(() => service.snapshot().connection === 'offline')
  assert.equal(lastRun(service)?.status, 'running', '断线处理没有把正在收尾的这一轮标成中断')
  // 留足时间：断线处理若另起结算，这时早该放开任务了
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal(service.snapshot().busy, true, '收尾还没完，断线处理没有替它放开任务')
  await assert.rejects(ask(service, '下一轮'), /请先等待/)

  release()
  const first = await settle(service)
  assert.equal(first.status, 'completed', '代理已经结束了这一轮，按它的结果收尾，不标成中断')
  assert.match(first.reply, /做完了/)
  live.finishBaseline = realFinish

  await ask(service, '下一轮')
  const second = await settle(service)
  assert.equal(second.status, 'completed')
  assert.equal(service.snapshot().busy, false)
  assert.equal(service.snapshot().items.flatMap(item => item.runs).find(run => run.id === first.id)?.status, 'completed')
})

test('ACP 规划（Claude 式交计划）：代理用 ExitPlanMode 一类审批交计划时，YOLO 也不放行；宿主收下计划、替用户选继续规划，确认后才切回原模式执行', async t => {
  const home = await tempDir('fd-acp-claude-plan-')
  const project = join(home, 'project')
  await mkdir(project, { recursive: true })
  const planText = '## 计划\n1. 读画布结构\n2. 在 a.txt 里补上说明'
  // 选项照抄 Claude Code 适配器的 ExitPlanMode：几个「始终允许」、一个「允许一次」、拒绝即继续规划
  const exitPlanOptions = [
    { optionId: 'acceptEdits', name: 'Yes, auto-accept edits', kind: 'allow_always' },
    { optionId: 'default', name: 'Yes, manually approve edits', kind: 'allow_once' },
    { optionId: 'no', name: 'No, keep planning', kind: 'reject_once' }
  ]
  const fake = await scriptedAcp(join(home, 'fake'), {
    modes: [{ id: 'default', name: 'Default' }, { id: 'acceptEdits', name: 'Accept Edits' }, { id: 'plan', name: 'Plan' }],
    mode: 'acceptEdits',
    cases: {
      PLAN_CLAUDE: [
        { say: '我先看了画布。' },
        { tool: { toolCallId: 'ep1', title: 'Approve Plan', kind: 'switch_mode', rawInput: { plan: planText } } },
        // 审批请求里不带 kind（和 Claude 一样），身份靠前面的 tool_call 补上；拒绝时 Claude 中断这一轮、以 cancelled 结束
        { perm: { toolCallId: 'ep1', title: 'Approve Plan', rawInput: { plan: planText }, options: exitPlanOptions, stopOnReject: 'cancelled', setModeOnAllow: 'default' } },
        // 只有被放行时才会走到这里：在规划轮里直接改文件
        { write: { path: 'edited-in-plan.txt', content: '不该出现\n' } },
        { say: '开始改了' }
      ],
      '已确认上述计划': [{ echo: true }]
    }
  })
  const service = makeService(join(home, 'app'), process.execPath)
  t.after(() => service.close().catch(() => undefined))
  await connectFake(service, fake)
  await service.setWorkspace('default', project)
  await service.setApprovalMode('full-access')

  await ask(service, 'PLAN_CLAUDE', 'plan')
  const planned = await settle(service)
  assert.equal(planned.status, 'planned', '交了计划、代理随后自己以 cancelled 结束：按规划完成收尾')
  assert.equal(planned.plan, planText, '计划正文取自交计划的审批')
  assert.deepEqual((await fake.choices()).at(-1), { outcome: 'selected', optionId: 'no' }, '替用户选了「继续规划」，YOLO 没有放行')
  assert.equal(planned.approvals.length, 0, '不弹审批卡')
  const handIn = planned.tools.find(tool => tool.id === 'ep1')
  assert.equal(handIn?.status, 'completed', '交计划的调用显示为已处理，不显示失败')
  assert.match(handIn?.result ?? '', /计划已收下/)
  await assert.rejects(readFile(join(project, 'edited-in-plan.txt'), 'utf8'), '规划轮里没有动手改文件')
  assert.equal(service.snapshot().acp?.currentModeId, 'plan', '代理仍停在规划模式')

  await service.execute('')
  const executed = await settle(service)
  assert.equal(executed.status, 'completed')
  assert.match(executed.reply, /mode=acceptEdits;/, '确认执行前切回规划前的模式')
  const modes = (await fake.received('session/set_mode')).map(m => m.params?.modeId)
  assert.deepEqual(modes, ['plan', 'acceptEdits'])
})

test('ACP 规划：没有规划能力时不能拟计划；切入或切回规划失败时这一轮的 session/prompt 一次都不发，并说明原因', async t => {
  const home = await tempDir('fd-acp-plan-fail-')

  const none = await scriptedAcp(join(home, 'none'), { modes: [{ id: 'default', name: 'Default' }] })
  const s1 = makeService(join(home, 'a1'), process.execPath)
  t.after(() => s1.close().catch(() => undefined))
  await connectFake(s1, none)
  assert.equal(acpPlanTarget(s1.snapshot().acp), null)
  await assert.rejects(ask(s1, '拟个计划', 'plan'), /没有提供规划模式/)
  assert.equal((await none.received('session/prompt')).length, 0)
  assert.equal(lastRun(s1)?.status, 'failed')
  assert.match(lastRun(s1)?.error ?? '', /没有提供规划模式/)

  const lockedIn = await scriptedAcp(join(home, 'in'), { modeConfig: ['default', 'plan'], failSetMode: ['plan'] })
  const s2 = makeService(join(home, 'a2'), process.execPath)
  t.after(() => s2.close().catch(() => undefined))
  await connectFake(s2, lockedIn)
  await assert.rejects(ask(s2, '拟个计划', 'plan'), /没能切换到 .*规划模式.*mode locked/)
  assert.equal((await lockedIn.received('session/prompt')).length, 0)
  assert.match(lastRun(s2)?.error ?? '', /本轮没有发送/)

  const lockedOut = await scriptedAcp(join(home, 'out'), { modes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }], failSetMode: ['default'] })
  const s3 = makeService(join(home, 'a3'), process.execPath)
  t.after(() => s3.close().catch(() => undefined))
  await connectFake(s3, lockedOut)
  await ask(s3, '拟个计划', 'plan')
  assert.equal((await settle(s3)).status, 'planned')
  await assert.rejects(s3.execute(''), /没能退出规划模式/)
  assert.equal((await lockedOut.received('session/prompt')).length, 1, '确认执行这一轮没有发出')
  assert.equal(lastRun(s3)?.status, 'failed')
  assert.match(lastRun(s3)?.error ?? '', /mode locked/)
})

test('ACP 图片：只有代理明确声明 promptCapabilities.image === true 时才附画布截图', async t => {
  const home = await tempDir('fd-acp-image-')
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
  const scene = JSON.stringify({ elements: [{ id: 'box1', type: 'rectangle', x: 0, y: 0, width: 120, height: 60, angle: 0, isDeleted: false }] })
  const variants = [
    { name: 'default', caps: {}, image: false },
    { name: 'off', caps: { promptCapabilities: { image: false } }, image: false },
    { name: 'on', caps: { promptCapabilities: { image: true } }, image: true }
  ]
  for (const variant of variants) {
    const fake = await scriptedAcp(join(home, variant.name), { caps: variant.caps })
    const service = makeService(join(home, `${variant.name}-app`), process.execPath)
    try {
      await connectFake(service, fake)
      assert.equal(service.snapshot().vision, variant.image, `${variant.name}：看图入口跟着能力走`)
      await service.submit({ board: 'default', goal: '看看这块画板', mode: 'direct', capture: { sceneJson: scene, selectedIds: [], pngBase64: png } })
      await settle(service)
      const [prompt] = await fake.received('session/prompt')
      const blocks = prompt.params!.prompt as { type: string; text?: string }[]
      assert.deepEqual(blocks.map(b => b.type), variant.image ? ['text', 'image'] : ['text'])
      assert.match(blocks[0].text ?? '', /看看这块画板/)
    } finally {
      await service.close()
    }
  }
})

test('ACP 收尾：分清 end_turn / cancelled / refusal / max_tokens / max_turn_requests，保留部分回复，没完成的工具不算成功，没有计划正文不给执行', async t => {
  const home = await tempDir('fd-acp-stop-')
  const fake = await scriptedAcp(join(home, 'fake'), {
    modeConfig: ['default', 'plan'],
    cases: {
      REFUSE_IT: [{ say: '先看了一部分' }, { tool: { toolCallId: 'r1', title: 'read_file', kind: 'read', rawInput: { path: 'a.txt' } } }, { stop: 'refusal' }],
      TRUNCATE_IT: [{ say: '写到一半' }, { stop: 'max_tokens' }],
      TURNS_IT: [{ say: '做了几步' }, { stop: 'max_turn_requests' }],
      PLAN_CUT: [{ say: '计划写到一半' }, { stop: 'max_tokens' }],
      PLAN_EMPTY: [],
      HANG_IT: [{ say: '处理中' }, { hang: true }]
    }
  })
  const service = makeService(join(home, 'app'), process.execPath)
  t.after(() => service.close().catch(() => undefined))
  await connectFake(service, fake)

  const reasons: [string, RegExp, RegExp][] = [
    ['REFUSE_IT', /refusal/, /先看了一部分/],
    ['TRUNCATE_IT', /max_tokens/, /写到一半/],
    ['TURNS_IT', /max_turn_requests/, /做了几步/]
  ]
  for (const [goal, reason, partial] of reasons) {
    await ask(service, goal)
    const run = await settle(service)
    assert.equal(run.status, 'failed', goal)
    assert.match(run.error ?? '', reason)
    assert.match(run.reply, partial, '部分回复保留')
    if (goal === 'REFUSE_IT') assert.notEqual(run.tools.find(tool => tool.id === 'r1')?.status, 'completed', '没收到完成事件的工具不显示成功')
  }

  await ask(service, 'PLAN_CUT', 'plan')
  const cut = await settle(service)
  assert.equal(cut.status, 'failed', '截断的规划不能确认执行')
  assert.match(cut.error ?? '', /max_tokens/)

  await ask(service, 'PLAN_EMPTY', 'plan')
  const empty = await settle(service)
  assert.equal(empty.status, 'failed')
  assert.equal(empty.plan, undefined, '不造占位计划')
  assert.match(empty.error ?? '', /没有给出计划内容/)
  await assert.rejects(service.execute(''), /没有等待确认的计划/)

  await ask(service, 'HANG_IT')
  await waitFor(() => lastRun(service)?.draft)
  await service.cancel()
  const cancelled = await settle(service)
  assert.equal(cancelled.status, 'cancelled')
  assert.match(cancelled.reply, /处理中/)

  await ask(service, '正常的一轮')
  const normal = await settle(service)
  assert.equal(normal.status, 'completed')
  assert.match(normal.reply, /mode=default;/, '规划失败后下一轮回到原模式')
})

test('ACP 会话恢复：加载失败时保留原任务和会话 ID，重试仍提交原 ID，恢复后接着旧会话；新任务是独立工作项', async t => {
  const home = await tempDir('fd-acp-resume-')
  const fake = await scriptedAcp(join(home, 'fake'), { caps: { loadSession: true }, loadFailTimes: 1 })
  const service = makeService(join(home, 'app'), process.execPath)
  t.after(() => service.close().catch(() => undefined))
  await connectFake(service, fake)
  await ask(service, '第一轮')
  await settle(service)
  const original = service.snapshot().items[0]
  const sid = original.sessionId
  assert.ok(sid)

  await service.newTask('default')
  await service.openTask(original.id)
  let snap = service.snapshot()
  assert.equal(snap.acpResume?.reason, 'error')
  assert.match(snap.acpResume?.message ?? '', /history unavailable/)
  assert.equal(snap.activeItemId, original.id, '历史记录照常显示')
  assert.equal(snap.items.find(item => item.id === original.id)?.sessionId, sid, '原会话 ID 没被换掉')
  assert.equal(snap.items.find(item => item.id === original.id)?.runs.length, 1)
  await assert.rejects(ask(service, '第二轮'), /重试恢复/)

  await service.openTask(original.id)
  snap = service.snapshot()
  assert.equal(snap.acpResume, undefined)
  assert.deepEqual((await fake.received('session/load')).map(m => m.params?.sessionId), [sid, sid], '重试仍提交原 ID')
  await ask(service, '第二轮')
  await settle(service)
  assert.equal((await fake.received('session/prompt')).at(-1)?.params?.sessionId, sid, '恢复后接着旧会话')
  assert.equal(service.snapshot().items.find(item => item.id === original.id)?.runs.length, 2)

  await service.newTask('default')
  await ask(service, '另起一项')
  await settle(service)
  snap = service.snapshot()
  assert.equal(snap.items.length, 2)
  const other = snap.items.find(item => item.id !== original.id)!
  assert.notEqual(other.sessionId, sid)
  assert.equal(snap.items.find(item => item.id === original.id)?.runs.length, 2, '新任务不往旧任务里加')

  // 代理根本没声明恢复能力：同样保留原任务，只能查看，明确开始新任务后才能继续
  const plain = await scriptedAcp(join(home, 'plain'), {})
  const s2 = makeService(join(home, 'app2'), process.execPath)
  t.after(() => s2.close().catch(() => undefined))
  await connectFake(s2, plain)
  await ask(s2, '第一轮')
  await settle(s2)
  const item2 = s2.snapshot().items[0]
  await s2.newTask('default')
  await s2.openTask(item2.id)
  assert.equal(s2.snapshot().acpResume?.reason, 'unsupported')
  assert.equal(s2.snapshot().items[0].sessionId, item2.sessionId)
  await assert.rejects(ask(s2, '接着做'), /只能查看/)
})

test('ACP 长时间待审批：跨过原来的 30 分钟时限仍可回答；停止后远端收到取消，代理不响应就结束连接，迟到事件不进下一轮', async t => {
  const home = await tempDir('fd-acp-long-')
  const fake = await scriptedAcp(join(home, 'fake'), {
    caps: { loadSession: true },
    ignoreCancel: true,
    cases: {
      SLOW_IT: [{ perm: { toolCallId: 'slow', title: 'run', kind: 'execute', rawInput: { cmd: 'build' } } }, { say: '审批后完成' }],
      STUCK_IT: [{ say: '开始' }, { hang: true }]
    }
  })
  const service = makeService(join(home, 'app'), process.execPath, { grace: 150 })
  t.after(() => service.close().catch(() => undefined))
  await connectFake(service, fake)

  // 受控时钟：发出这一轮之前接管 setTimeout，任何挂在 session/prompt 上的总时限都会被快进触发
  const until = async <T>(check: () => T | null | undefined | false): Promise<T> => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const value = check()
      if (value) return value
      await new Promise(resolve => setImmediate(resolve))
    }
    throw new Error('等待超时')
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await ask(service, 'SLOW_IT')
    const approval = await until(() => lastRun(service)?.approvals.find(a => !a.answered))
    t.mock.timers.tick(31 * 60 * 1000)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(lastRun(service)?.status, 'running', '跨过 30 分钟后这一轮还在')
    assert.equal(service.snapshot().busy, true)
    await service.approve(approval.requestId, true)
    const done = await until(() => {
      const run = lastRun(service)
      return !service.snapshot().busy && run && run.status !== 'running' ? run : null
    })
    assert.equal(done.status, 'completed')
    assert.match(done.reply, /审批后完成/)
  } finally {
    t.mock.timers.reset()
  }

  await ask(service, 'STUCK_IT')
  await waitFor(() => lastRun(service)?.draft)
  await service.cancel()
  const stopped = await settle(service)
  assert.equal(stopped.status, 'cancelled')
  assert.match(stopped.error ?? '', /没有响应停止/)
  assert.ok(stopped.roundChanges, '旧进程退出后结算了这一轮的改动快照')
  assert.equal((await fake.received('session/cancel')).length, 1, '远端收到了取消')
  assert.ok((await fake.entries()).some(e => e.exit !== undefined), '放开下一轮之前旧进程已经退出')

  await ask(service, '下一轮')
  const next = await settle(service)
  assert.equal(next.status, 'completed')
  assert.equal((await fake.received('initialize')).length, 2, '旧连接已结束，下一轮用的是新连接')
  const log = await fake.entries()
  const starts = log.flatMap((e, i) => e.argv ? [i] : [])
  assert.ok(log.findIndex(e => e.exit !== undefined) < starts[1], '新代理在旧进程退出之后才启动')
  await new Promise(resolve => setTimeout(resolve, 1700))
  assert.doesNotMatch(lastRun(service)?.reply ?? '', /LATE/)
  assert.doesNotMatch(service.snapshot().items.flatMap(item => item.runs).map(run => run.reply).join('\n'), /LATE/)
})

test('Windows 批处理启动器：带空格和中文的目录里的 .cmd 能完成握手，程序路径和每个参数的边界不变', { skip: process.platform !== 'win32' }, async t => {
  const root = await tempDir('fd-acp-cmd-')
  const fake = await scriptedAcp(join(root, '带 空格 的目录 & 更多'), {})
  const cmd = join(fake.dir, 'start acp.cmd')
  await writeFile(cmd, `@"${process.execPath}" "%~dp0scripted-acp.mjs" "%~dp0fake.json" %*\r\n`, 'utf8')
  const args = ['--name', 'a b c', 'x&y', '100%', 'C:\\Program Files\\some tool\\', '中文 参数']
  const client = new AcpClient({ command: cmd, args })
  t.after(() => client.stop())
  const init = await client.start()
  assert.equal(init.agentInfo?.name, 'Fake ACP')
  const direct = new AcpClient({ command: process.execPath, args: [fake.script, fake.cfgPath, 'a b'] })
  t.after(() => direct.stop())
  await direct.start()
  assert.deepEqual((await fake.entries()).filter(e => e.argv).map(e => e.argv), [args, ['a b']])
})

test('windowsBatchLaunch 交给 cmd.exe 时整条命令行原样传递', () => {
  const launch = windowsBatchLaunch('C:\\a b\\run.cmd', ['x y', 'q"z'], 'cmd.exe')
  assert.equal(launch.file, 'cmd.exe')
  assert.deepEqual(launch.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(launch.windowsVerbatimArguments, true)
  assert.equal(launch.args[3], '"C:\\a^ b\\run.cmd ^"x^ y^" ^"q\\^"z^""')
})

test('ACP 设置：参数按数组保存，含空格的路径是一项；每个预设各自保存命令和参数，重启后都能恢复；旧版单配置能沿用', async t => {
  const home = await tempDir('fd-acp-profiles-')
  const fake = await scriptedAcp(join(home, 'script dir with space'), {})
  const claudeArgs = [fake.script, fake.cfgPath, '--profile', 'claude 一号']
  const codexArgs = [fake.script, fake.cfgPath, '--profile', 'codex 二号']
  let reviews = 0
  const s1 = makeService(join(home, 'app'), process.execPath, { confirm: async () => { reviews++; return true } })
  await s1.setEngine('acp', 'default', { preset: 'claude', command: process.execPath, args: claudeArgs, seat: '小克' })
  await s1.setAcpConfig({ preset: 'codex', command: process.execPath, args: codexArgs, seat: '小码' }, 'default')
  await s1.setAcpConfig({ preset: 'claude' }, 'default')
  assert.deepEqual(s1.snapshot().acpConfig?.args, claudeArgs)
  assert.equal(s1.snapshot().seat, '小克')
  assert.deepEqual(s1.snapshot().acpProfiles?.codex?.args, codexArgs, '快照里带出其他预设已保存的配置，方便设置页切换卡片时回显')
  assert.equal(s1.snapshot().acpProfiles?.codex?.seat, '小码')
  await s1.close()

  const s2 = makeService(join(home, 'app'), process.execPath, { confirm: async () => { reviews++; return true } })
  assert.deepEqual(s2.snapshot().acpConfig?.args, claudeArgs, '重启后恢复当前预设')
  await s2.connect('default')
  await s2.setAcpConfig({ preset: 'codex' }, 'default')
  assert.deepEqual(s2.snapshot().acpConfig?.args, codexArgs, '切到另一个预设取回它自己的参数')
  assert.equal(s2.snapshot().seat, '小码')
  await s2.close()
  assert.equal(reviews, 2, '两组程序各确认一次；切预设、重启、重连都沿用')
  assert.deepEqual(
    (await fake.entries()).filter(e => e.argv).map(e => e.argv),
    [['--profile', 'claude 一号'], ['--profile', 'codex 二号'], ['--profile', 'claude 一号'], ['--profile', 'claude 一号'], ['--profile', 'codex 二号']],
    '假代理实际收到的参数和输入一致，含空格的参数没被拆开'
  )

  const legacyHome = join(home, 'legacy')
  await mkdir(join(legacyHome, 'agent'), { recursive: true })
  await writeFile(join(legacyHome, 'agent', 'host-settings.json'), JSON.stringify({
    engine: 'acp',
    acpConfig: { preset: 'codex', command: process.execPath, args: codexArgs, seat: '旧席位', label: '旧 Codex' },
    acpSeats: { claude: '旧克' }
  }))
  const s3 = makeService(legacyHome, process.execPath)
  t.after(() => s3.close().catch(() => undefined))
  assert.equal(s3.snapshot().acpConfig?.preset, 'codex')
  assert.deepEqual(s3.snapshot().acpConfig?.args, codexArgs)
  assert.equal(s3.snapshot().seat, '旧席位')
  const profiles = (s3 as unknown as { acpProfiles: Record<string, { seat: string }> }).acpProfiles
  assert.equal(profiles.claude?.seat, '旧克', '旧版按预设记的席位归入各自预设')
})

test('ACP 启动确认：内置默认预设直接连；首次自定义程序、改参数各确认一次，只改席位或重连不再问；取消时原连接和配置不变；旧版自定义配置首次使用确认后沿用', async t => {
  const home = await tempDir('fd-acp-trust-')
  const fake = await scriptedAcp(join(home, 'fake'), {})
  const runner = await fakeLauncher(fake)
  const reviews: AcpLaunchReview[] = []
  let answer = true
  const service = makeService(join(home, 'app'), runner, { confirm: async launch => { reviews.push(launch); return answer } })
  t.after(() => service.close().catch(() => undefined))

  await service.setEngine('acp', 'default', { preset: 'claude' })
  assert.equal(service.snapshot().connection, 'ready')
  assert.equal(reviews.length, 0, '内置预设用自动探测的程序和默认参数，不弹确认')

  await service.setAcpConfig({ args: ['--verbose'] }, 'default')
  assert.deepEqual(reviews, [{ preset: 'claude', label: 'Claude Code', command: runner, args: ['--verbose'] }])
  await service.setAcpConfig({ seat: '新席位' }, 'default')
  await service.setAcpConfig({}, 'default')
  assert.equal(reviews.length, 1, '只改席位名、重连相同配置不再询问')

  const initsBefore = (await fake.received('initialize')).length
  answer = false
  await assert.rejects(service.setAcpConfig({ args: ['--other'] }, 'default'), /没有确认启动/)
  const kept = service.snapshot()
  assert.deepEqual(kept.acpConfig?.args, ['--verbose'])
  assert.equal(kept.seat, '新席位')
  assert.equal(kept.connection, 'ready', '原连接保持')
  assert.equal((await fake.received('initialize')).length, initsBefore, '没有启动新进程')
  assert.equal(reviews.length, 2)

  answer = true
  await service.setAcpConfig({ preset: 'custom', command: runner, args: [] }, 'default')
  assert.equal(reviews.length, 3)
  assert.equal(reviews[2].preset, 'custom')
  await service.close()

  const legacyHome = join(home, 'legacy')
  await mkdir(join(legacyHome, 'agent'), { recursive: true })
  await writeFile(join(legacyHome, 'agent', 'host-settings.json'), JSON.stringify({
    engine: 'acp', acpConfig: { preset: 'custom', command: runner, args: ['--legacy'], seat: '旧代理', label: '旧代理' }
  }))
  const legacyReviews: AcpLaunchReview[] = []
  const old = makeService(legacyHome, runner, { confirm: async launch => { legacyReviews.push(launch); return true } })
  await old.connect('default')
  assert.equal(old.snapshot().connection, 'ready')
  assert.equal(legacyReviews.length, 1)
  assert.deepEqual(legacyReviews[0].args, ['--legacy'])
  await old.close()
  const again = makeService(legacyHome, runner, { confirm: async launch => { legacyReviews.push(launch); return true } })
  await again.connect('default')
  assert.equal(again.snapshot().connection, 'ready')
  assert.equal(legacyReviews.length, 1, '确认过的旧配置重启后沿用')
  await again.close()
})

test('ACP 登录报错：内置预设给出各自的登录命令，自定义代理显示它自己的认证说明', async t => {
  const home = await tempDir('fd-acp-login-')
  const fake = await scriptedAcp(join(home, 'fake'), {
    authRequired: true,
    authMessage: 'Please sign in',
    authMethods: [{ id: 'oauth', name: 'Fake 登录', description: '运行 fake-cli auth 完成登录' }]
  })
  const runner = await fakeLauncher(fake)
  const hints: [AcpPresetId, string][] = [['antigravity', 'agy acp --login'], ['claude', 'claude login'], ['codex', 'codex login'], ['opencode', 'opencode auth login']]
  for (const [preset, hint] of hints) {
    const service = makeService(join(home, preset), runner)
    try {
      await assert.rejects(service.setEngine('acp', 'default', { preset }), (error: Error) => {
        assert.ok(error.message.includes(hint), `${preset}：${error.message}`)
        return true
      })
    } finally {
      await service.close()
    }
  }
  const custom = makeService(join(home, 'custom'), runner)
  try {
    await assert.rejects(custom.setEngine('acp', 'default', { preset: 'custom', command: runner, args: [] }), (error: Error) => {
      assert.match(error.message, /运行 fake-cli auth 完成登录/)
      assert.match(error.message, /Please sign in/)
      assert.doesNotMatch(error.message, /agy acp|claude login|codex login|opencode auth/)
      return true
    })
  } finally {
    await custom.close()
  }
})
