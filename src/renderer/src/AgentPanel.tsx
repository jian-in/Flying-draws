import { useEffect, useRef, useState } from 'react'
import { toolDisplayName, type AgentCapture, type AgentResultImage, type AgentRun, type AgentState, type ProviderDraft } from '../../shared/agent'

const LABEL: Record<AgentRun['status'], string> = {
  running: '进行中', planned: '等你确认计划', completed: '已完成', unverified: '结果待核验',
  cancelled: '已停止', failed: '未完成', interrupted: '已中断'
}
const EMPTY: AgentState = {
  connection: 'offline', error: null, busy: false, setupNeeded: true, vision: false,
  provider: '', model: '', choices: [], workspace: '', activeItemId: null, items: []
}
const DEFAULT_PROVIDER: ProviderDraft = {
  protocol: 'openai-compatible', name: 'my-model', base_url: '', credential: '', model: '',
  context_window: 128000, max_tokens: 8192, vision: false
}

export function AgentPanel({ open, board, onClose, capture, insertImage }: {
  open: boolean; board: string; onClose(): void; capture(): Promise<AgentCapture>; insertImage(image: AgentResultImage, dataURL: string): Promise<void>
}) {
  const [state, setState] = useState<AgentState>(EMPTY)
  const [goal, setGoal] = useState('')
  const [planFirst, setPlanFirst] = useState(true)
  const [continuation, setContinuation] = useState<'resume' | 'new'>('resume')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  const [provider, setProvider] = useState(DEFAULT_PROVIDER)
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const api = window.flyingdraws.agent
  const active = state.items.find(item => item.id === state.activeItemId && !item.archived && (item.board === board || state.busy))
  const last = active?.runs.at(-1)
  const items = state.items.filter(item => item.board === board && !item.archived)
  const disabled = working || state.busy || state.connection !== 'ready'
  const approvals = last?.approvals.filter(a => !a.answered) ?? []
  const canResume = Boolean(last?.taskId && last.mode !== 'plan' && ['interrupted', 'cancelled', 'failed'].includes(last.status))
  const resumePrevious = canResume && continuation === 'resume'

  useEffect(() => {
    let live = true
    void api.state().then(value => { if (live) setState(value) })
    const off = api.onState(value => { if (live) setState(value) })
    return () => { live = false; off() }
  }, [])
  useEffect(() => {
    if (!open) return
    setError(null)
    void api.connect(board).catch(error => setError(String(error.message ?? error)))
  }, [open, board, state.busy])
  useEffect(() => { setContinuation(last?.status === 'failed' ? 'new' : 'resume') }, [last?.id, last?.status])
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [state, open])

  async function act(action: () => Promise<unknown>): Promise<boolean> {
    setWorking(true)
    setError(null)
    try { await action(); return true }
    catch (error) { setError(error instanceof Error ? error.message : '操作失败'); return false }
    finally { setWorking(false) }
  }
  async function send() {
    if (!goal.trim() || disabled) return
    const text = goal
    const success = await act(async () => {
      const context = await capture()
      await api.submit({ board, goal: text, capture: context, mode: planFirst ? 'plan' : 'direct', resume: resumePrevious })
    })
    if (success) { setGoal(''); follow.current = true }
  }
  async function execute() {
    if (await act(() => api.execute(goal.trim()))) { setGoal(''); follow.current = true }
  }
  async function saveModel() {
    if (await act(() => api.configure(provider))) {
      setProvider(value => ({ ...value, credential: '' }))
      setSettings(false)
    }
  }

  return (
    <aside className="fd-agent" hidden={!open} aria-label="内置 Agent">
      <header className="fd-agent-heading">
        <div><span className="fd-agent-eyebrow">FLYING DRAWS / FUXI</span><h2>一起把想法做出来</h2></div>
        <button className="fd-agent-icon" onClick={onClose} title="收起 Agent" aria-label="收起 Agent">×</button>
      </header>
      <div className="fd-agent-toolbar">
        <span className={`fd-agent-dot fd-agent-dot-${state.busy ? 'working' : state.connection}`} />
        <span role="status">{state.busy ? '正在工作' : state.connection === 'starting' ? '连接内核中…' : state.connection === 'ready' ? state.setupNeeded ? '请设置模型' : '准备好了' : '内核未连接'}</span>
        <button onClick={() => setSettings(value => !value)} disabled={state.busy}>{settings ? '返回任务' : '模型设置'}</button>
      </div>
      {state.recordsWarning ? <div className="fd-agent-alert fd-agent-small" role="status">{state.recordsWarning}</div> : null}
      {settings ? (
        <form className="fd-agent-settings" onSubmit={event => { event.preventDefault(); void saveModel() }}>
          <h3>连接你的模型</h3>
          <p>使用自己的服务地址和密钥，推理由内置 Fuxi 执行。</p>
          <label>接口协议<select value={provider.protocol} onChange={e => setProvider({ ...provider, protocol: e.target.value as ProviderDraft['protocol'] })}>
            <option value="openai-compatible">OpenAI 兼容</option><option value="anthropic-messages">Anthropic Messages</option><option value="gemini">Gemini</option>
          </select></label>
          <label>配置名称（英文）<input required value={provider.name} pattern="[A-Za-z0-9_-]+" maxLength={64} onChange={e => setProvider({ ...provider, name: e.target.value })} /></label>
          <label>服务地址<input required type="url" placeholder="https://你的服务地址/v1" value={provider.base_url} onChange={e => setProvider({ ...provider, base_url: e.target.value })} /></label>
          <label>API Key<input required type="password" autoComplete="off" spellCheck={false} placeholder="密钥，或 env:变量名" value={provider.credential} onChange={e => setProvider({ ...provider, credential: e.target.value })} /></label>
          <label>模型 ID<input required placeholder="服务商提供的模型 ID" value={provider.model} onChange={e => setProvider({ ...provider, model: e.target.value })} /></label>
          <label className="fd-agent-check"><input type="checkbox" checked={provider.vision} onChange={e => setProvider({ ...provider, vision: e.target.checked })} />该模型支持图片输入</label>
          <details><summary>上下文与输出上限</summary><div className="fd-agent-limits">
            <label>上下文 tokens<input type="number" min={4096} max={2000000} value={provider.context_window} onChange={e => setProvider({ ...provider, context_window: Number(e.target.value) })} /></label>
            <label>单次输出 tokens<input type="number" min={1} max={provider.context_window} value={provider.max_tokens} onChange={e => setProvider({ ...provider, max_tokens: Number(e.target.value) })} /></label>
          </div></details>
          <p className="fd-agent-small">密钥保存在本机的应用配置里。保存配置不会发送任务。</p>
          <button className="fd-agent-primary" type="submit" disabled={disabled}>{working ? '保存中…' : '保存并使用'}</button>
          {error || state.error ? <p className="fd-agent-error" role="alert">{error || state.error}</p> : null}
        </form>
      ) : (
        <>
          <div className="fd-agent-context">
            <div className="fd-agent-model-row">
              <select aria-label="当前模型" disabled={disabled} value={JSON.stringify([state.provider, state.model])} onChange={e => {
                const [provider, model] = JSON.parse(e.target.value) as string[]
                void act(() => api.selectModel(provider, model))
              }}>
                {!state.choices.some(c => c.provider === state.provider && c.model === state.model) ? <option value={JSON.stringify([state.provider, state.model])}>{state.setupNeeded ? '尚未配置模型' : state.model}</option> : null}
                {state.choices.map(choice => <option key={`${choice.provider}/${choice.model}`} value={JSON.stringify([choice.provider, choice.model])}>{choice.model} · {choice.provider}</option>)}
              </select>
              <button onClick={() => void act(() => api.newTask(board))} disabled={disabled} title="在当前画板开始一项新任务">＋ 新任务</button>
            </div>
            <button className="fd-agent-workspace" disabled={disabled} onClick={() => void act(() => api.chooseWorkspace(board))} title={state.workspace || '选择项目文件夹'}>
              <span>工作目录</span><span>{!state.workspace || state.workspace.replace(/\\/g, '/').includes('/agent/workspaces/') ? '应用专用目录' : state.workspace.replace(/\\/g, '/').split('/').slice(-2).join('/')}</span><span>↗</span>
            </button>
            {state.workspaceWarning ? <p className="fd-agent-small" role="status">{state.workspaceWarning}</p> : null}
            {items.length ? <select className="fd-agent-history" aria-label="任务历史" value={active?.id ?? ''} disabled={disabled} onChange={e => { if (e.target.value) void act(() => api.openTask(e.target.value)) }}>
              <option value="">新任务</option>{[...items].reverse().map(item => <option key={item.id} value={item.id}>{item.title || '未命名任务'}</option>)}
            </select> : null}
          </div>
          <div className="fd-agent-transcript" ref={scroll} onScroll={event => {
            const el = event.currentTarget
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70
          }}>
            {state.busy && active && active.board !== board ? <p className="fd-agent-alert fd-agent-small">正在处理画板「{active.board}」的任务；本轮结束后可在当前画板发起任务。</p> : null}
            {!active?.runs.length ? <div className="fd-agent-empty">
              <div className="fd-agent-sketch" aria-hidden="true"><span>想法</span><i>→</i><span>行动</span></div>
              <h3>从这一笔开始</h3>
              <p>画草图、圈出问题，或直接写下目标。Agent 会带着画布上下文开始工作。</p>
              <p className="fd-agent-small">选中元素时只发送选区；未选择时发送当前画板。需要操作文件时，请先选择项目目录。</p>
              {state.setupNeeded ? <button className="fd-agent-primary" onClick={() => setSettings(true)}>先连接模型</button> : null}
            </div> : active.runs.map((run, index) => <article className="fd-agent-run" key={run.id}>
              <div className="fd-agent-run-meta"><span>第 {index + 1} 轮 · {run.mode === 'plan' ? '规划' : run.mode === 'execute' ? '执行' : run.mode === 'resume' ? '续接' : '任务'}</span><span className={`fd-agent-run-status fd-agent-run-${run.status}`}>{LABEL[run.status]}</span></div>
              <p className="fd-agent-goal">{run.goal}</p>
              <Thinking run={run} />
              {/* A plan's text is the model's reply; show it once, inside the plan box. */}
              {run.reply && !run.plan ? <div className="fd-agent-reply">{run.reply}</div> : null}
              {run.draft ? <div className="fd-agent-reply fd-agent-draft">{run.draft}<span className="fd-agent-caret" /></div> : null}
              {run.plan ? <div className="fd-agent-plan"><strong>{run.status === 'planned' ? '待确认的计划' : '本轮计划'}</strong><div>{run.reply || planBody(run.plan)}</div></div> : null}
              {run.tools.length ? <details className="fd-agent-tools"><summary>工具记录 · {run.tools.length} 项{run.tools.some(t => t.status === 'running') && run.status === 'running' ? ' · 正在执行' : ''}</summary>
                {run.tools.map((tool, index) => <details key={`${tool.id}/${index}`}><summary><span>{tool.status === 'completed' ? '✓' : tool.status === 'failed' ? '×' : '·'}</span> {toolDisplayName(tool.name, state.toolLabels)}</summary><pre>{tool.input}{tool.result ? `\n\n${tool.result}` : ''}</pre></details>)}
              </details> : null}
              {run.images?.map(image => <ResultImage key={image.id} image={image} disabled={working || state.busy || active?.board !== board} onInsert={dataURL => act(() => insertImage(image, dataURL))} />)}
              {run.status === 'unverified' ? <p className="fd-agent-small">本轮已结束，仍有结果未经独立检查，请结合产物确认。</p> : null}
              {run.error ? <p className="fd-agent-error">{run.error}</p> : null}
            </article>)}
          </div>
          {approvals.map(approval => <div className="fd-agent-approval" key={approval.requestId} role="group" aria-label="工具审批">
            <strong>允许这项操作？</strong><span>{toolDisplayName(approval.name, state.toolLabels)}</span><pre>{approval.description}</pre>
            <div><button disabled={working} onClick={() => void act(() => api.approve(approval.requestId, false))}>拒绝</button><button className="fd-agent-primary" disabled={working} onClick={() => void act(() => api.approve(approval.requestId, true))}>本次允许</button></div>
          </div>)}
          {error || state.error ? <div className="fd-agent-error fd-agent-alert" role="alert">{error || state.error}</div> : null}
          <div className="fd-agent-composer">
            {state.connection !== 'ready' ? <button className="fd-agent-primary" disabled={state.connection === 'starting' || working} onClick={() => void act(() => api.connect(board))}>{state.connection === 'starting' ? '连接中…' : '重新连接内核'}</button> : <>
              {canResume ? <select className="fd-agent-continuation" aria-label="后续任务方式" disabled={working || state.busy} value={continuation} onChange={e => setContinuation(e.target.value as 'resume' | 'new')}>
                <option value="resume">继续原任务 · 沿用目标与预算</option><option value="new">同会话新目标 · 重新计预算</option>
              </select> : null}
              {!state.vision && !state.setupNeeded ? <div className="fd-agent-small">当前模型未启用图片，本轮只发送画布结构。</div> : null}
              <textarea aria-label="任务目标" placeholder={last?.status === 'planned' ? '可补充调整，再确认执行计划…' : '想让 Agent 做什么？'} value={goal} disabled={state.busy || state.setupNeeded} onChange={e => setGoal(e.target.value)} onKeyDown={e => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (last?.status === 'planned') void execute(); else void send() }
              }} rows={3} />
              <div className="fd-agent-actions">
                {resumePrevious ? <span className="fd-agent-small">沿用原任务的目标与预算</span> : <label className="fd-agent-check"><input type="checkbox" checked={planFirst} disabled={disabled} onChange={e => setPlanFirst(e.target.checked)} />先拟计划</label>}
                {state.busy ? <button className="fd-agent-stop" disabled={working} onClick={() => void act(() => api.cancel())}>停止</button>
                  : last?.status === 'planned' ? <button className="fd-agent-primary" disabled={disabled} onClick={() => void execute()}>确认并执行 ↗</button>
                    : <button className="fd-agent-primary" disabled={disabled || state.setupNeeded || !goal.trim()} onClick={() => void send()}>{resumePrevious ? '继续原任务' : planFirst ? '拟定计划' : '开始执行'} ↗</button>}
              </div>
            </>}
          </div>
        </>
      )}
    </aside>
  )
}

/** The kernel's plan summary repeats the whole request; keep only the plan itself. */
function planBody(plan: string): string {
  const lines = plan.split('\n').filter(line => !(line.includes('/execute') && line.includes('/plan clear')))
  const contract = lines.findIndex(line => line.startsWith('原验收：'))
  return (contract >= 0 ? lines.slice(contract + 1) : lines).join('\n').trim()
}

/** Folded reasoning: "思考中…" while it streams, "思考过程" afterwards; open on click. */
function Thinking({ run }: { run: AgentRun }) {
  const live = run.status === 'running' && Boolean(run.thinkingDraft)
  const waiting = run.status === 'running' && !run.thinkingDraft && !run.draft && !run.reply && !run.tools.some(t => t.status === 'running')
  const text = live ? [run.thinking, run.thinkingDraft].filter(Boolean).join('\n\n') : run.thinking
  if (!text && !waiting) return null
  if (!text) return <div className="fd-agent-thinking fd-agent-thinking-idle"><span className="fd-agent-thinking-dot" />思考中…</div>
  return <details className="fd-agent-thinking">
    <summary>{live ? <><span className="fd-agent-thinking-dot" />思考中…</> : '思考过程'}<span className="fd-agent-small">{text.length.toLocaleString()} 字</span></summary>
    <pre>{text}</pre>
  </details>
}

function ResultImage({ image, disabled, onInsert }: { image: AgentResultImage; disabled: boolean; onInsert(dataURL: string): Promise<unknown> }) {
  const [dataURL, setDataURL] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void window.flyingdraws.agent.image(image.id).then(data => { if (live) setDataURL(data) }, () => { if (live) setError('图片读取失败') })
    return () => { live = false }
  }, [image.id])
  return <figure className="fd-agent-result-image">
    {dataURL ? <img src={dataURL} alt={image.name} /> : <span>{error || '读取结果图片…'}</span>}
    <figcaption><span>结果图片</span><button disabled={disabled || !dataURL} onClick={() => dataURL && void onInsert(dataURL)}>放到画布 ↗</button></figcaption>
  </figure>
}
