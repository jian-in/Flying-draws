import { useEffect, useRef, useState } from 'react'
import { AgentMarkdown } from './AgentMarkdown'
import { planDisplay } from './planView'
import { AGENT_WIDTH_DEFAULT, AGENT_WIDTH_MAX, AGENT_WIDTH_MIN, clampAgentWidth } from './canvas/minimapGeometry'
import { shouldAutoPlaceResultImage } from '../../main/lineage'
import {
  ACP_PRESETS,
  acpAllowOnceOption,
  acpPlanTarget,
  acpPresetSpec,
  activeAgentSeat,
  DEFAULT_ACP_CONFIG,
  pickCompareImage,
  toolDisplayName,
  traceImageGoal,
  type AcpBackendConfig,
  type AcpConfigOption,
  type AcpPresetId,
  type AgentCapture,
  type AgentEngine,
  type AgentResultImage,
  type AgentRun,
  type AgentRunUsage,
  type AgentState,
  type AgentTelemetry,
  type ImageRegionAnnotation,
  type ProviderDraft,
  type RoundFileChange
} from '../../shared/agent'
import { BASE_URL_PLACEHOLDER, DEFAULT_PRESET, PROVIDER_PRESETS, type PresetId } from '../../shared/providerPresets'

const LABEL: Record<AgentRun['status'], string> = {
  running: '进行中', planned: '等你确认计划', completed: '已完成', unverified: '结果待核验',
  cancelled: '已停止', failed: '未完成', interrupted: '已中断',
  needs_review: '等你看一眼', rejected: '没改对'
}
/** 内核或 ACP 按规则自动放行（没有弹窗确认）的种类 */
const AUTO_APPROVED: Record<string, string> = {
  readonly_shell: '只读命令',
  task_preview: '本轮服务预览',
  task_job_cancel: '关闭本轮服务',
  task_rule: '本任务内已允许',
  yolo: 'YOLO'
}
const ACP_OPTION_LABELS: Record<string, string> = {
  thought_level: '思考深度',
  effort: '思考深度',
  reasoning_effort: '推理深度',
  mode: '协作模式',
  fast: '极速模式',
  'fast-mode': '极速模式',
  collaboration_mode: '协同方式',
  agent: '子代理'
}
const ACP_VALUE_LABELS: Record<string, string> = {
  none: '无',
  minimal: '极简',
  low: '轻度',
  medium: '均衡',
  high: '深度',
  xhigh: '极深',
  max: '最大',
  ultra: '极限',
  default: '默认',
  auto: '自动判断',
  'accept-edits': '自动改文件',
  acceptEdits: '自动改文件',
  bypassPermissions: '免确认',
  'read-only': '只读',
  'workspace-write': '可写工作区',
  agent: '代理',
  'agent-full-access': '完全权限',
  build: '构建',
  plan: '先规划',
  on: '开启',
  off: '关闭'
}
const ACP_STARTERS = [
  '读一下当前画板内容，帮我梳理一下重点',
  '把画布上选中的区域整理成更清晰的图示',
  '接着当前画板上的笔记往下讲，并在画布上补充图解'
]
const EMPTY: AgentState = {
  connection: 'offline', error: null, busy: false, setupNeeded: true, vision: false,
  provider: '', model: '', choices: [], engine: 'fuxi', seat: 'Fuxi',
  acpConfig: DEFAULT_ACP_CONFIG,
  workspace: '', activeItemId: null, items: [], approvalMode: 'auto-safe'
}

function AcpAgentMark({ preset }: { preset: AcpPresetId }) {
  if (preset === 'claude') {
    return (
      <svg className="fd-acp-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 2.8V21.2M4.1 7.4L19.9 16.6M19.9 7.4L4.1 16.6"
          stroke="currentColor"
          strokeWidth="2.3"
          strokeLinecap="round"
        />
        <circle cx="12" cy="12" r="2.6" fill="currentColor" />
      </svg>
    )
  }
  if (preset === 'codex') {
    return (
      <svg className="fd-acp-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 2.5L20.2 7.25V16.75L12 21.5L3.8 16.75V7.25L12 2.5Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path d="M9 9.5L12.5 12L9 14.5M13.2 14.5H16" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (preset === 'opencode') {
    return (
      <svg className="fd-acp-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M8.5 7L3.5 12L8.5 17M15.5 7L20.5 12L15.5 17" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M13.6 5.5L10.4 18.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.8" />
      </svg>
    )
  }
  if (preset === 'custom') {
    return (
      <svg className="fd-acp-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="2.8" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg className="fd-acp-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2.5" opacity="0.55" />
      <path
        d="M12 3.2L14.15 9.85L20.8 12L14.15 14.15L12 20.8L9.85 14.15L3.2 12L9.85 9.85L12 3.2Z"
        fill="currentColor"
      />
    </svg>
  )
}

function FuxiMark() {
  return (
    <svg className="fd-fuxi-mark" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="6" height="6" rx="1.4" stroke="currentColor" strokeWidth="1.6" />
      <rect x="11" y="11" width="6" height="6" rx="1.4" fill="currentColor" />
      <path d="M9 6H14V11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function formatAcpPath(path?: string | null): string {
  if (!path) return ''
  const norm = path.replace(/\\/g, '/')
  const parts = norm.split('/').filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : norm
}
/** 地址的协议 + 主机 + 端口；还没写成合法地址时返回 null */
function urlOrigin(value: string): string | null {
  try { return new URL(value).origin } catch { return null }
}
/** Electron 的 invoke 失败会把「Error invoking remote method …」前缀带进来，面板只显示正文 */
function readableIpcError(error: unknown, fallback = '操作失败'): string {
  const text = error instanceof Error ? error.message : String(error)
  const tail = text.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '').trim()
  return tail || fallback
}
function formatTokens(n: number): string {
  const value = Math.max(0, Math.round(n))
  if (value < 1_000) return String(value)
  if (value < 999_500) {
    const k = value / 1_000
    if (k >= 100) return `${Math.round(k)}k`
    const fixed = k.toFixed(1)
    return `${fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed}k`
  }
  const m = value / 1_000_000
  return `${m >= 100 ? Math.round(m) : m.toFixed(1)}M`
}
function formatRunUsage(usage?: AgentRunUsage): string {
  if (!usage) return ''
  const parts: string[] = []
  if (usage.spentTokens > 0) parts.push(`消耗 ${formatTokens(usage.spentTokens)} tokens`)
  if (usage.requestsUsed > 0) parts.push(`${usage.requestsUsed} 次请求`)
  if (typeof usage.cacheHitRate === 'number' && (usage.cacheObservations ?? 0) > 0) {
    parts.push(`缓存命中 ${Math.round(usage.cacheHitRate * 100)}%`)
  }
  return parts.join(' · ')
}

export function AgentPanel({
  open,
  board,
  onClose,
  capture,
  insertImage,
  placedImageIds,
  selectedImage,
  selectedCount = 0,
  onClearSelection,
  traceCapture
}: {
  open: boolean
  board: string
  onClose(): void
  capture(): Promise<AgentCapture>
  insertImage(image: AgentResultImage, dataURL: string, opts?: { auto?: boolean; annotations?: readonly ImageRegionAnnotation[]; seat?: string }): Promise<void>
  /** 当前画布上已放置的结果图 ID 集合（用于自动上墙去重与按钮状态同步） */
  placedImageIds?: ReadonlySet<string>
  /** 画布上正好选中一张图片时是它的 id */
  selectedImage: string | null
  /** 当前选中的画布元素数量（用于提示本次发送范围是选区还是整张画板） */
  selectedCount?: number
  onClearSelection?: () => void
  /** 取出选中图片的原图（必要时缩小），连同它的像素尺寸 */
  traceCapture(): Promise<{ imageId: string; width: number; height: number; capture: AgentCapture }>
}) {
  const [state, setState] = useState<AgentState>(EMPTY)
  const [goal, setGoal] = useState('')
  // 默认直接执行；需要先看计划时再勾上「先拟计划」
  const [planFirst, setPlanFirst] = useState(false)
  const [autoLineage, setAutoLineage] = useState<boolean>(() => {
    try { return window.localStorage.getItem('fd:auto-lineage') !== '0' } catch { return true }
  })
  const [continuation, setContinuation] = useState<'resume' | 'new'>('resume')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  const [preset, setPreset] = useState<PresetId>(DEFAULT_PRESET)
  const [provider, setProvider] = useState<ProviderDraft>(PROVIDER_PRESETS[DEFAULT_PRESET].draft)
  const [acpDraft, setAcpDraft] = useState<{ preset: AcpPresetId; command: string; argsText: string; seat: string; label: string }>({
    preset: DEFAULT_ACP_CONFIG.preset ?? 'antigravity',
    command: DEFAULT_ACP_CONFIG.command,
    argsText: DEFAULT_ACP_CONFIG.args.join('\n'),
    seat: DEFAULT_ACP_CONFIG.seat,
    label: DEFAULT_ACP_CONFIG.label ?? 'Antigravity'
  })
  // 设置面板里「拉取模型列表」的结果：只用于把服务商返回的 ID 填进模型输入框
  const [modelList, setModelList] = useState<string[]>([])
  const [modelsBusy, setModelsBusy] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [previewSrc, setPreviewSrc] = useState<{ src: string; alt: string } | null>(null)
  const [confirmYolo, setConfirmYolo] = useState(false)
  const yolo = state.approvalMode === 'full-access'
  const engine: AgentEngine = state.engine === 'acp' ? 'acp' : 'fuxi'
  const isAcp = engine === 'acp'
  const acpPreset: AcpPresetId = state.acpConfig?.preset ?? state.acp?.preset ?? 'antigravity'
  const acpPresetInfo = acpPresetSpec(acpPreset)
  const seatName = activeAgentSeat(state)
  const acpBrand = state.acpConfig?.label?.trim() || acpPresetInfo?.label || 'Antigravity'
  const rawQuickOptions: AcpConfigOption[] = (state.acp?.configOptions ?? []).filter(
    opt => opt.id !== 'model' && opt.category !== 'model' && opt.options.length > 0
  )
  const hasModeOption = rawQuickOptions.some(opt => opt.id === 'mode' || opt.category === 'mode')
  const acpQuickOptions: AcpConfigOption[] = !hasModeOption && state.acp?.modes?.length
    ? [
        ...rawQuickOptions,
        {
          id: 'mode',
          name: '协作模式',
          category: 'mode',
          currentValue: state.acp.currentModeId || state.acp.modes[0].id,
          options: state.acp.modes.map(m => ({ value: m.id, name: m.name, ...(m.description ? { description: m.description } : {}) }))
        }
      ]
    : rawQuickOptions
  // ACP 代理声明了规划模式（session modes 或 configOptions 里的 mode=plan）才能先拟计划
  const planSupported = !isAcp || Boolean(acpPlanTarget(state.acp))
  const resumeFailure = isAcp ? state.acpResume : undefined
  // 只读查看的历史任务（两种引擎通用）和没恢复的 ACP 会话一样：记录照常显示，不能接着发
  const readOnlyTask = state.readOnlyTask
  const taskLocked = Boolean(resumeFailure || readOnlyTask)
  const currentChoice = state.choices.find(c => c.provider === state.provider && c.model === state.model)
  const currentModelLabel = currentChoice?.label || state.model || (
    readOnlyTask ? '只读查看'
      : resumeFailure ? '会话未恢复'
      : isAcp ? (state.connection === 'ready' ? '代理默认模型' : '等待连接')
        : '尚未配置模型'
  )
  // 上面那块设置（模型、工作目录、任务）可以收起成一行，给对话留出空间；收起状态记在本机
  const [contextCollapsed, setContextCollapsed] = useState<boolean>(() => {
    try { return window.localStorage.getItem('fd:agent-context-collapsed') === '1' } catch { return false }
  })
  function toggleContext(collapse: boolean) {
    setContextCollapsed(collapse)
    try { window.localStorage.setItem('fd:agent-context-collapsed', collapse ? '1' : '0') } catch {}
  }
  const workspacePath = state.workspace.replace(/\\/g, '/')
  const workspaceLabel = !state.workspace || workspacePath.includes('/agent/workspaces/') ? '应用专用目录' : workspacePath.split('/').slice(-2).join('/')
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [following, setFollowing] = useState(true)
  const lastScrollTopRef = useRef(0)
  const programmaticScrollTopRef = useRef<number | null>(null)
  const pointerDownRef = useRef(false)
  const initialSeeded = useRef(false)

  function updateFollow(next: boolean) {
    follow.current = next
    setFollowing(prev => (prev === next ? prev : next))
  }

  function scrollToBottom() {
    const el = scroll.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    const targetTop = el.scrollTop
    programmaticScrollTopRef.current = targetTop
    lastScrollTopRef.current = targetTop
  }
  const trackedItemRef = useRef<string | null>(null)
  const autoHandledIds = useRef<Set<string>>(new Set())
  const insertImageRef = useRef(insertImage)
  insertImageRef.current = insertImage
  const api = window.flyingdraws.agent
  const active = state.items.find(item => item.id === state.activeItemId && !item.archived && (item.board === board || state.busy))
  const last = active?.runs.at(-1)
  const items = state.items.filter(item =>
    item.board === board && !item.archived && (item.engine ?? 'fuxi') === engine && (!isAcp || (item.acpPreset ?? 'antigravity') === acpPreset)
  )
  const disabled = working || state.busy || state.connection !== 'ready'
  const approvals = last?.approvals.filter(a => !a.answered) ?? []
  const currentApproval = approvals[0] ?? null
  const canResume = !isAcp && Boolean(last?.taskId && last.mode !== 'plan' && ['interrupted', 'cancelled', 'failed'].includes(last.status))
  const resumePrevious = canResume && continuation === 'resume'
  const alertError = error || (state.error && state.error !== last?.error ? state.error : null)
  const telemetry: AgentTelemetry | null = state.telemetry
    ? state.telemetry
    : last?.usage
      ? {
          contextTokens: last.usage.contextTokens ?? 0,
          contextLimit: last.usage.contextLimit ?? 0,
          cacheHitRate: last.usage.cacheHitRate ?? null,
          cacheObservations: last.usage.cacheObservations ?? 0,
          requestsUsed: last.usage.requestsUsed,
          spentTokens: last.usage.spentTokens,
          estimatedCost: last.usage.estimatedCost
        }
      : null

  useEffect(() => {
    let live = true
    let receivedPush = false
    const seedAndApply = (value: AgentState) => {
      if (!initialSeeded.current) {
        initialSeeded.current = true
        trackedItemRef.current = value.activeItemId
        if (!value.busy) {
          for (const item of value.items) {
            for (const r of item.runs) {
              for (const img of r.images ?? []) autoHandledIds.current.add(img.id)
            }
          }
        }
      }
      setState(value)
    }
    void api
      .state()
      .then(value => {
        if (!live || receivedPush) return
        seedAndApply(value)
      })
      .catch(err => {
        if (live) setError(readableIpcError(err))
      })
    const off = api.onState(value => {
      if (!live) return
      receivedPush = true
      seedAndApply(value)
    })
    return () => { live = false; off() }
  }, [])
  useEffect(() => {
    if (!initialSeeded.current) return
    const currentBoardItem = state.items.find(
      item => item.id === state.activeItemId && !item.archived && item.board === board
    )
    if (!currentBoardItem) return
    if (trackedItemRef.current !== currentBoardItem.id) {
      trackedItemRef.current = currentBoardItem.id
      const lastRun = currentBoardItem.runs.at(-1)
      const isHistorical =
        !state.busy &&
        currentBoardItem.runs.every(r => r.status !== 'running') &&
        Boolean(lastRun?.endedAt && Date.now() - Date.parse(lastRun.endedAt) > 5_000)
      if (isHistorical) {
        for (const r of currentBoardItem.runs) {
          for (const img of r.images ?? []) autoHandledIds.current.add(img.id)
        }
        return
      }
    }
    // 每轮只自动上墙一张：本轮结束后挑出的「改后」对照图（没有就取最后一张页面截图）。
    // 其余截图留在侧栏，需要时手动「放到画布」，免得源图上扇出一堆箭头。
    for (const r of currentBoardItem.runs) {
      if (r.status === 'running') continue
      const pending = (r.images ?? []).filter(img => !autoHandledIds.current.has(img.id))
      if (!pending.length) continue
      for (const img of pending) autoHandledIds.current.add(img.id)
      if (!autoLineage) continue
      const target = (r.compareImageId && r.images?.find(img => img.id === r.compareImageId)) || pickCompareImage(r, state.toolLabels)
      if (!target || !pending.includes(target) || !shouldAutoPlaceResultImage(target, state.toolLabels)) continue
      if (placedImageIds?.has(target.id)) continue
      void api
        .image(target.id)
        .then(dataURL => insertImageRef.current(target, dataURL, { auto: true, annotations: r.annotations, seat: seatName }))
        .catch(() => undefined)
    }
  }, [state, board, autoLineage, placedImageIds])
  useEffect(() => {
    setError(null)
    updateFollow(true)
  }, [open, board, active?.id])
  useEffect(() => {
    if (!open || state.busy) return
    void api.connect(board).catch(err => setError(readableIpcError(err)))
  }, [open, board, state.busy])
  useEffect(() => { setContinuation(last?.status === 'failed' ? 'new' : 'resume') }, [last?.id, last?.status])
  useEffect(() => {
    const clearPointer = () => { pointerDownRef.current = false }
    window.addEventListener('pointerup', clearPointer)
    window.addEventListener('pointercancel', clearPointer)
    window.addEventListener('blur', clearPointer)
    return () => {
      window.removeEventListener('pointerup', clearPointer)
      window.removeEventListener('pointercancel', clearPointer)
      window.removeEventListener('blur', clearPointer)
    }
  }, [])
  useEffect(() => {
    const cfg = state.acpConfig
    if (!cfg) return
    setAcpDraft({
      preset: cfg.preset ?? 'antigravity',
      command: cfg.command ?? '',
      argsText: (cfg.args ?? []).join('\n'),
      seat: cfg.seat || DEFAULT_ACP_CONFIG.seat,
      label: cfg.label || acpPresetSpec(cfg.preset)?.label || 'Antigravity'
    })
  }, [state.acpConfig?.preset, state.acpConfig?.command, state.acpConfig?.seat, state.acpConfig?.label, state.acpConfig?.args?.join('\n')])
  useEffect(() => {
    if (open && follow.current && !pointerDownRef.current) scrollToBottom()
  }, [state, open])

  function draftForAcpPreset(presetId: AcpPresetId) {
    const saved = presetId === state.acpConfig?.preset
      ? state.acpConfig
      : state.acpProfiles?.[presetId]
    const spec = acpPresetSpec(presetId)
    if (saved) {
      return {
        preset: presetId,
        command: saved.command ?? '',
        argsText: (saved.args ?? []).join('\n'),
        seat: saved.seat || spec?.defaultSeat || 'ACP',
        label: saved.label || spec?.label || '自定义 ACP'
      }
    }
    return {
      preset: presetId,
      command: '',
      argsText: spec ? spec.defaultArgs.join('\n') : '',
      seat: spec?.defaultSeat ?? 'ACP',
      label: spec?.label ?? '自定义 ACP'
    }
  }
  function openSettingsPanel(next: boolean) {
    if (next && isAcp) setAcpDraft(draftForAcpPreset(acpPreset))
    setSettings(next)
  }

  async function act(action: () => Promise<unknown>): Promise<boolean> {
    setWorking(true)
    setError(null)
    try { await action(); return true }
    catch (error) { setError(readableIpcError(error)); return false }
    finally { setWorking(false) }
  }
  async function fetchModels() {
    if (!provider.base_url.trim() || !provider.credential.trim()) {
      setModelsError('先填服务地址和 API Key，再拉取模型列表')
      return
    }
    setModelsBusy(true)
    setModelsError(null)
    try {
      const list = await api.models({
        protocol: provider.protocol,
        base_url: provider.base_url.trim(),
        credential: provider.credential.trim()
      })
      setModelList(list)
      setModelsError(list.length ? null : '服务商没有返回任何模型，模型 ID 需要手填')
    } catch (error) {
      setModelList([])
      setModelsError(readableIpcError(error, '拉取失败'))
    } finally {
      setModelsBusy(false)
    }
  }

  async function send() {
    if (!goal.trim() || disabled || taskLocked) return
    const text = goal
    const success = await act(async () => {
      const context = await capture()
      await api.submit({ board, goal: text, capture: context, mode: planFirst && planSupported ? 'plan' : 'direct', resume: resumePrevious })
    })
    if (success) { setGoal(''); updateFollow(true); scrollToBottom() }
  }
  // 把选中的图片照原样转成可编辑的方框、文字和线条：结果以提议的形式画在原图旁边，确认后才落到画布上
  async function traceSelected() {
    if (!selectedImage || disabled || !state.vision || taskLocked) return
    const success = await act(async () => {
      const { imageId, width, height, capture: context } = await traceCapture()
      await api.submit({
        board, goal: traceImageGoal(imageId, width, height), display: '把选中的图片转成可编辑图',
        capture: context, mode: 'direct', resume: false
      })
    })
    if (success) { updateFollow(true); scrollToBottom() }
  }
  async function execute() {
    if (disabled || taskLocked) return
    if (await act(() => api.execute(goal.trim()))) { setGoal(''); updateFollow(true); scrollToBottom() }
  }
  async function saveModel() {
    if (await act(() => api.configure(provider))) {
      setProvider(value => ({ ...value, credential: '' }))
      setSettings(false)
    }
  }
  async function switchEngine(next: AgentEngine) {
    if (next === engine || state.busy || working) return
    setSettings(false)
    await act(() => api.setEngine(next, board))
  }
  async function switchAcpPreset(nextPreset: AcpPresetId) {
    if (state.busy || working) return
    if (isAcp && nextPreset === acpPreset && state.connection === 'ready') return
    setSettings(false)
    if (!isAcp) {
      await act(() => api.setEngine('acp', board, { preset: nextPreset }))
    } else {
      await act(() => api.setAcpConfig({ preset: nextPreset }, board))
    }
  }
  async function saveAcpSettings() {
    // 每行一个参数：含空格的路径占一行，保存成数组里的一项
    const args = acpDraft.argsText.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const spec = acpPresetSpec(acpDraft.preset)
    const payload: Partial<AcpBackendConfig> = {
      preset: acpDraft.preset,
      command: acpDraft.command.trim(),
      args,
      seat: acpDraft.seat.trim() || spec?.defaultSeat || DEFAULT_ACP_CONFIG.seat,
      label: acpDraft.label.trim() || spec?.label || '自定义 ACP'
    }
    if (await act(() => api.setAcpConfig(payload, board))) {
      setSettings(false)
    }
  }

  const [panelWidth, setPanelWidth] = useState<number>(() => {
    try {
      const saved = Number(window.localStorage.getItem('fd:agent-width'))
      return saved > 0 ? clampAgentWidth(saved, window.innerWidth) : AGENT_WIDTH_DEFAULT
    } catch { return AGENT_WIDTH_DEFAULT }
  })
  const [resizing, setResizing] = useState(false)
  const resizeDragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const panelWidthRef = useRef(panelWidth)
  panelWidthRef.current = panelWidth

  useEffect(() => {
    const onWinResize = () => setPanelWidth(w => clampAgentWidth(w, window.innerWidth))
    window.addEventListener('resize', onWinResize)
    return () => window.removeEventListener('resize', onWinResize)
  }, [])
  useEffect(() => {
    document.body.classList.toggle('fd-resizing', resizing)
    return () => document.body.classList.remove('fd-resizing')
  }, [resizing])

  const persistPanelWidth = (next: number | ((prev: number) => number)) => {
    setPanelWidth(prev => {
      const target = typeof next === 'function' ? next(prev) : next
      const clamped = clampAgentWidth(target, window.innerWidth)
      try { window.localStorage.setItem('fd:agent-width', String(clamped)) } catch {}
      return clamped
    })
  }

  const composerRef = useRef<HTMLTextAreaElement>(null)

  return (
    <aside
      className={`fd-agent${isAcp ? ' fd-agent-acp' : ''}${resizing ? ' fd-agent-resizing' : ''}`}
      data-engine={engine}
      data-acp-preset={isAcp ? acpPreset : undefined}
      style={{ width: `${panelWidth}px`, flexBasis: `${panelWidth}px` }}
      hidden={!open}
      aria-label="内置 Agent"
    >
      <div
        className="fd-agent-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整 Agent 侧栏宽度"
        aria-valuemin={AGENT_WIDTH_MIN}
        aria-valuemax={AGENT_WIDTH_MAX}
        aria-valuenow={panelWidth}
        tabIndex={0}
        title="左右拖动调整宽度 · 双击恢复默认"
        onDoubleClick={() => persistPanelWidth(AGENT_WIDTH_DEFAULT)}
        onKeyDown={e => {
          if (e.key === 'ArrowLeft') { e.preventDefault(); persistPanelWidth(w => w + 24) }
          else if (e.key === 'ArrowRight') { e.preventDefault(); persistPanelWidth(w => w - 24) }
          else if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); persistPanelWidth(AGENT_WIDTH_DEFAULT) }
        }}
        onPointerDown={e => {
          if (e.button !== 0) return
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          resizeDragRef.current = { startX: e.clientX, startWidth: panelWidthRef.current }
          setResizing(true)
        }}
        onPointerMove={e => {
          const drag = resizeDragRef.current
          if (!drag) return
          e.preventDefault()
          const next = clampAgentWidth(drag.startWidth + (drag.startX - e.clientX), window.innerWidth)
          setPanelWidth(next)
        }}
        onPointerUp={e => {
          if (!resizeDragRef.current) return
          resizeDragRef.current = null
          setResizing(false)
          try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
          persistPanelWidth(panelWidthRef.current)
        }}
        onPointerCancel={() => {
          if (!resizeDragRef.current) return
          resizeDragRef.current = null
          setResizing(false)
        }}
      />
      <header className="fd-agent-heading">
        <div className="fd-agent-brand">
          {isAcp ? <span className="fd-acp-avatar" aria-hidden="true"><AcpAgentMark preset={acpPreset} /></span> : null}
          <div className="fd-agent-title-group">
            <span className="fd-agent-eyebrow">
              {isAcp ? `FLYING DRAWS · ${acpBrand.toUpperCase()} ACP` : 'FLYING DRAWS / FUXI'}
            </span>
            <h2>{isAcp ? `和 ${acpBrand} 一起画与写` : '一起把想法做出来'}</h2>
            {isAcp ? (
              <div className="fd-acp-badges">
                {state.acp?.tier ? <span className="fd-acp-badge fd-acp-badge-tier">✦ {state.acp.tier}</span> : null}
                <span className="fd-acp-badge" title="在画布上落笔和提议时使用的席位名">@{seatName}</span>
                {state.acp?.version ? <span className="fd-acp-badge fd-acp-badge-muted">v{state.acp.version}</span> : null}
              </div>
            ) : null}
          </div>
        </div>
        <button className="fd-agent-icon" onClick={onClose} title="收起 Agent" aria-label="收起 Agent">×</button>
      </header>
      <div className="fd-engine-switch" role="tablist" aria-label="切换 Agent 引擎">
        <button
          type="button"
          role="tab"
          aria-selected={!isAcp}
          className={!isAcp ? 'fd-engine-tab fd-engine-tab-active' : 'fd-engine-tab'}
          disabled={state.busy || working}
          onClick={() => void switchEngine('fuxi')}
          title="使用内置 Fuxi 内核与自定义 API 模型"
        >
          <FuxiMark />
          <span>Fuxi 内置</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={isAcp}
          className={isAcp ? 'fd-engine-tab fd-engine-tab-active fd-engine-tab-acp' : 'fd-engine-tab'}
          disabled={state.busy || working}
          onClick={() => void switchEngine('acp')}
          title="通过标准 ACP 协议连接本地 Antigravity / Claude / Codex / OpenCode"
        >
          <AcpAgentMark preset={acpPreset} />
          <span>{acpBrand} · ACP</span>
        </button>
      </div>
      {isAcp ? (
        <div className="fd-acp-roster" role="tablist" aria-label="切换 ACP Agent">
          {ACP_PRESETS.map(spec => {
            const activePreset = acpPreset === spec.id
            const detected = Boolean(state.acp?.detectedPresets?.[spec.id])
            return (
              <button
                key={spec.id}
                type="button"
                role="tab"
                aria-selected={activePreset}
                className={`fd-acp-roster-btn${activePreset ? ' fd-acp-roster-btn-active' : ''}`}
                data-preset={spec.id}
                disabled={state.busy || working}
                title={detected ? `${spec.label}（已检测到本机 CLI，点击切换）` : `${spec.label}（未检测到：${spec.installHint}）`}
                onClick={() => void switchAcpPreset(spec.id)}
              >
                <span className={`fd-acp-roster-dot${detected ? ' fd-acp-roster-dot-ok' : ''}`} aria-hidden="true" />
                <span>{spec.shortLabel}</span>
              </button>
            )
          })}
        </div>
      ) : null}
      <div className="fd-agent-toolbar">
        <span className={`fd-agent-dot fd-agent-dot-${state.busy ? 'working' : state.connection}`} />
        <span role="status">
          {state.busy
            ? (approvals.length ? '等你确认操作' : isAcp ? `${acpBrand} 正在思考与执行` : '正在工作')
            : state.connection === 'starting'
              ? (isAcp ? `正在连接 ${acpBrand}（ACP）…` : '连接内核中…')
              : state.connection === 'ready'
                ? (state.setupNeeded ? '请设置模型' : isAcp ? `${acpBrand} 已就绪` : '准备好了')
                : (isAcp ? 'ACP 未连接' : '内核未连接')}
        </span>
        <button
          className={yolo ? 'fd-agent-yolo fd-agent-yolo-on' : 'fd-agent-yolo'}
          aria-pressed={yolo}
          disabled={working}
          title={yolo ? 'YOLO 已开启：所有工具调用都不再确认，直接执行。点击关闭' : '开启 YOLO：所有工具调用都不再逐次确认'}
          onClick={() => { if (yolo) void act(() => api.setApprovalMode('auto-safe')); else setConfirmYolo(true) }}
        >YOLO{yolo ? ' · 开' : ''}</button>
        <button onClick={() => openSettingsPanel(!settings)} disabled={state.busy}>
          {settings ? '返回任务' : isAcp ? 'ACP 设置' : '模型设置'}
        </button>
      </div>
      {confirmYolo ? <div className="fd-agent-approval fd-agent-yolo-confirm" role="alertdialog" aria-label="开启 YOLO">
        <strong><span>开启 YOLO 模式？</span></strong>
        <p className="fd-agent-small">开启后，Agent 的所有操作（运行命令、改文件、git push、删除、起服务、访问网页）都不再问你，直接在这台电脑上执行，不是沙箱。只在这次打开期间有效，退出应用后自动关闭。</p>
        <p className="fd-agent-small">建议先提交或备份未提交的改动。</p>
        <div><button disabled={working} onClick={() => setConfirmYolo(false)}>取消</button><button className="fd-agent-stop" disabled={working} onClick={() => void act(() => api.setApprovalMode('full-access')).then(ok => { if (ok) setConfirmYolo(false) })}>开启 YOLO</button></div>
      </div> : null}
      {state.recordsWarning ? <div className="fd-agent-alert fd-agent-small" role="status">{state.recordsWarning}</div> : null}
      {settings && isAcp ? (() => {
        const draftSpec = acpPresetSpec(acpDraft.preset)
        const draftDetected = acpDraft.preset === 'custom' ? null : (state.acp?.detectedPresets?.[acpDraft.preset] ?? null)
        return (
        <form className="fd-agent-settings fd-acp-settings" onSubmit={event => { event.preventDefault(); void saveAcpSettings() }}>
          <h3>连接本地 ACP Agent</h3>
          <p>通过标准 Agent Client Protocol 接入本地 CLI，自动挂载当前画布 MCP 工具。</p>
          <div className="fd-acp-preset-grid" role="group" aria-label="选择 ACP 预设">
            {ACP_PRESETS.map(spec => {
              const found = state.acp?.detectedPresets?.[spec.id]
              const selected = acpDraft.preset === spec.id
              return (
                <button
                  key={spec.id}
                  type="button"
                  className={`fd-acp-preset-card${selected ? ' fd-acp-preset-card-active' : ''}`}
                  data-preset={spec.id}
                  onClick={() => {
                    if (acpDraft.preset === spec.id) return
                    setAcpDraft(draftForAcpPreset(spec.id))
                  }}
                >
                  <span className="fd-acp-preset-head">
                    <AcpAgentMark preset={spec.id} />
                    <strong>{spec.label}</strong>
                  </span>
                  <span className={`fd-acp-preset-state${found ? ' fd-acp-preset-state-ok' : ''}`}>
                    {found ? '✓ 已检测' : '未安装'}
                  </span>
                </button>
              )
            })}
            <button
              type="button"
              className={`fd-acp-preset-card${acpDraft.preset === 'custom' ? ' fd-acp-preset-card-active' : ''}`}
              data-preset="custom"
              onClick={() => {
                if (acpDraft.preset === 'custom') return
                setAcpDraft(draftForAcpPreset('custom'))
              }}
            >
              <span className="fd-acp-preset-head">
                <AcpAgentMark preset="custom" />
                <strong>自定义 ACP</strong>
              </span>
              <span className="fd-acp-preset-state">手动命令</span>
            </button>
          </div>
          {acpDraft.preset !== 'custom' ? (
            <div className={`fd-acp-detect ${draftDetected ? 'fd-acp-detect-ok' : 'fd-acp-detect-miss'}`}>
              <span className="fd-acp-detect-dot" aria-hidden="true" />
              <div>
                <strong>{draftDetected ? `已检测到本地 ${draftSpec?.label}` : `未检测到本地 ${draftSpec?.label}`}</strong>
                <p className="fd-agent-small">
                  {draftDetected
                    ? formatAcpPath(draftDetected)
                    : `安装方式：${draftSpec?.installHint ?? '请先安装对应 ACP CLI'}`}
                </p>
              </div>
            </div>
          ) : null}
          <label>画布席位名
            <input
              required
              maxLength={40}
              placeholder={`例如 ${draftSpec?.defaultSeat ?? 'ACP'}`}
              value={acpDraft.seat}
              onChange={e => setAcpDraft({ ...acpDraft, seat: e.target.value })}
            />
          </label>
          <label>面板显示名称
            <input
              maxLength={48}
              placeholder={draftSpec?.label ?? '自定义 ACP'}
              value={acpDraft.label}
              onChange={e => setAcpDraft({ ...acpDraft, label: e.target.value })}
            />
          </label>
          <label>ACP 可执行命令（{acpDraft.preset === 'custom' ? '必填' : '留空自动检测'}）
            <input
              required={acpDraft.preset === 'custom'}
              spellCheck={false}
              placeholder={draftDetected ? `自动：${formatAcpPath(draftDetected)}` : '留空自动检测，或填完整路径'}
              value={acpDraft.command}
              onChange={e => setAcpDraft({ ...acpDraft, command: e.target.value })}
            />
          </label>
          <label>启动参数（每行一个，含空格的路径也只占一行；无参数可留空）
            <textarea
              className="fd-acp-args"
              spellCheck={false}
              rows={Math.min(6, Math.max(2, acpDraft.argsText.split('\n').length + 1))}
              placeholder={draftSpec?.defaultArgs.join('\n') || '（无默认参数）'}
              value={acpDraft.argsText}
              onChange={e => setAcpDraft({ ...acpDraft, argsText: e.target.value })}
            />
          </label>
          <p className="fd-agent-small">改了程序或参数后，第一次启动前会弹窗列出实际要运行的程序和每个参数，确认后才连接。</p>
          {draftSpec ? (
            <p className="fd-agent-small">直接复用本机 {draftSpec.label} 登录态与配置；若提示未登录，可在终端运行 <code>{draftSpec.loginHint}</code>。</p>
          ) : (
            <p className="fd-agent-small">支持任意实现标准 Agent Client Protocol（stdio JSON-RPC 2.0）的本地命令行代理。</p>
          )}
          <button className="fd-agent-primary" type="submit" disabled={working || state.busy}>
            {working ? '连接中…' : '保存并重新连接'}
          </button>
          {error || state.error ? <p className="fd-agent-error" role="alert">{error || state.error}</p> : null}
        </form>
        )
      })() : settings ? (
        <form className="fd-agent-settings" onSubmit={event => { event.preventDefault(); void saveModel() }}>
          <h3>连接你的模型</h3>
          <p>使用自己的服务地址和密钥，推理由内置 Fuxi 执行。</p>
          {state.connection !== 'ready' ? (
            <div style={{ marginBottom: 12 }}>
              <button type="button" disabled={state.connection === 'starting' || working} onClick={() => void act(() => api.connect(board))}>
                {state.connection === 'starting' ? '正在连接内核…' : '先重新连接内核'}
              </button>
            </div>
          ) : null}
          <label>服务商<select value={preset} onChange={e => {
            const id = e.target.value as PresetId
            setPreset(id)
            // 换服务商时清掉已填的密钥，免得把一家的密钥发给另一家的地址
            setProvider({ ...PROVIDER_PRESETS[id].draft })
            setModelList([])
            setModelsError(null)
          }}>
            {(Object.keys(PROVIDER_PRESETS) as PresetId[]).map(id => <option key={id} value={id}>{PROVIDER_PRESETS[id].label}</option>)}
          </select></label>
          {PROVIDER_PRESETS[preset].hint ? <p className="fd-agent-small fd-agent-preset-hint">{PROVIDER_PRESETS[preset].hint}</p> : null}
          <label>接口协议<select value={provider.protocol} onChange={e => setProvider({ ...provider, protocol: e.target.value as ProviderDraft['protocol'] })}>
            <option value="openai-compatible">OpenAI 兼容</option><option value="anthropic-messages">Anthropic Messages</option><option value="gemini">Gemini</option>
          </select></label>
          <label>配置名称（英文）<input required value={provider.name} pattern="[A-Za-z0-9_-]+" maxLength={64} onChange={e => setProvider({ ...provider, name: e.target.value })} /></label>
          <label>服务地址<input required type="url" placeholder={BASE_URL_PLACEHOLDER[provider.protocol]} value={provider.base_url} onChange={e => {
            const base_url = e.target.value
            // 服务地址换了主机就清掉已填的密钥（并不再显示为预设），免得把一家的密钥发到另一家的地址
            if (urlOrigin(base_url) === urlOrigin(provider.base_url)) { setProvider({ ...provider, base_url }); return }
            setProvider({ ...provider, base_url, credential: '' })
            setPreset('custom')
            setModelList([])
            setModelsError(null)
          }} /></label>
          <label>API Key<input required type="password" autoComplete="off" spellCheck={false} placeholder={PROVIDER_PRESETS[preset].credentialPlaceholder ?? '密钥，或 env:变量名'} value={provider.credential} onChange={e => setProvider({ ...provider, credential: e.target.value })} /></label>
          <label>模型 ID<input required placeholder="服务商提供的模型 ID（可点下方拉取）" value={provider.model} onChange={e => setProvider({ ...provider, model: e.target.value })} /></label>
          <div className="fd-agent-models">
            <button type="button" disabled={modelsBusy} onClick={() => void fetchModels()}>{modelsBusy ? '拉取中…' : '拉取模型列表'}</button>
            {modelList.length ? <select aria-label="服务商返回的模型" value={modelList.includes(provider.model) ? provider.model : ''} onChange={e => {
              const id = e.target.value
              if (id) setProvider({ ...provider, model: id })
            }}>
              <option value="">选一个填进模型 ID（共 {modelList.length} 个）</option>
              {modelList.map(id => <option key={id} value={id}>{id}</option>)}
            </select> : null}
            {modelsError ? <p className="fd-agent-error" role="alert">{modelsError}</p> : null}
          </div>
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
          {contextCollapsed && !state.setupNeeded ? <div className="fd-agent-context fd-agent-context-collapsed">
            <button className="fd-agent-context-summary" title="展开模型、工作目录和任务设置" aria-expanded={false} onClick={() => toggleContext(false)}>
              <span>{currentModelLabel} · {workspaceLabel} · {active?.title || '新任务'}</span><span>展开 ▾</span>
            </button>
            {state.workspaceWarning ? <p className="fd-agent-small" role="status">{state.workspaceWarning}</p> : null}
          </div> : <div className="fd-agent-context">
            <div className="fd-agent-model-row">
              <select aria-label="当前模型" disabled={disabled || taskLocked} value={JSON.stringify([state.provider, state.model])} onChange={e => {
                const [provider, model] = JSON.parse(e.target.value) as string[]
                void act(() => api.selectModel(provider, model))
              }}>
                {!state.choices.some(c => c.provider === state.provider && c.model === state.model) ? <option value={JSON.stringify([state.provider, state.model])}>{state.setupNeeded ? '尚未配置模型' : currentModelLabel}</option> : null}
                {state.choices.map(choice => (
                  <option key={`${choice.provider}/${choice.model}`} value={JSON.stringify([choice.provider, choice.model])}>
                    {isAcp ? (choice.label || choice.model) : `${choice.model} · ${choice.provider}`}
                  </option>
                ))}
              </select>
              <button onClick={() => void act(() => api.newTask(board))} disabled={disabled} title="在当前画板开始一项新任务">＋ 新任务</button>
              {!state.setupNeeded ? <button className="fd-agent-context-toggle" aria-expanded={true} title="收起这块设置，给对话留出更多空间" onClick={() => toggleContext(true)}>收起 ▴</button> : null}
            </div>
            {isAcp && acpQuickOptions.length ? (
              <div className="fd-acp-controls" aria-label={`${acpBrand} 会话选项`}>
                {acpQuickOptions.map(opt => (
                  <div className="fd-acp-control-row" key={opt.id}>
                    <span className="fd-acp-control-label">{ACP_OPTION_LABELS[opt.id] ?? opt.name}</span>
                    {opt.options.length > 6 ? (
                      <select
                        className="fd-acp-select"
                        aria-label={ACP_OPTION_LABELS[opt.id] ?? opt.name}
                        disabled={disabled}
                        value={opt.currentValue}
                        onChange={e => {
                          const next = e.target.value
                          if (next && next !== opt.currentValue) void act(() => api.setAcpConfigOption(opt.id, next))
                        }}
                      >
                        {opt.options.map(choice => (
                          <option key={choice.value} value={choice.value} title={choice.description || choice.name}>
                            {ACP_VALUE_LABELS[choice.value] ?? choice.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="fd-acp-pills" role="group" aria-label={ACP_OPTION_LABELS[opt.id] ?? opt.name}>
                        {opt.options.map(choice => {
                          const activeOpt = opt.currentValue === choice.value
                          return (
                            <button
                              key={choice.value}
                              type="button"
                              className={activeOpt ? 'fd-acp-pill fd-acp-pill-active' : 'fd-acp-pill'}
                              aria-pressed={activeOpt}
                              disabled={disabled}
                              title={choice.description || choice.name}
                              onClick={() => { if (!activeOpt) void act(() => api.setAcpConfigOption(opt.id, choice.value)) }}
                            >
                              {ACP_VALUE_LABELS[choice.value] ?? choice.name}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
            <button className="fd-agent-workspace" disabled={disabled} onClick={() => void act(() => api.chooseWorkspace(board))} title={state.workspace || '选择项目文件夹'}>
              <span>工作目录</span><span>{workspaceLabel}</span><span>↗</span>
            </button>
            {state.workspaceWarning ? <p className="fd-agent-small" role="status">{state.workspaceWarning}</p> : null}
            {state.toolStorage?.mode === 'host' ? <p className="fd-agent-small" title={state.toolStorage.artifactsDir}>截图和运行日志存在应用数据目录，不写进项目。只读命令、本轮自己起的服务的预览和关闭不再逐次确认。</p> : null}
            {items.length ? <div className="fd-agent-history-row">
              <select className="fd-agent-history" aria-label="任务历史" value={active?.id ?? ''} disabled={disabled} onChange={e => {
                if (e.target.value) void act(() => api.openTask(e.target.value))
                else void act(() => api.newTask(board))
              }}>
                <option value="">新任务</option>{[...items].reverse().map(item => <option key={item.id} value={item.id}>{item.title || '未命名任务'}</option>)}
              </select>
              <button
                type="button"
                className="fd-agent-history-delete"
                disabled={disabled || !active}
                title="删除当前任务的聊天记录（画布内容不受影响）"
                onClick={() => {
                  if (!active) return
                  if (!window.confirm(`确定删除任务「${active.title || '未命名任务'}」的聊天记录吗？画布内容不受影响。`)) return
                  void act(() => api.deleteTask(active.id))
                }}
              >删除</button>
            </div> : null}
            {!isAcp ? (
              <label
                className="fd-agent-check fd-agent-lineage-toggle"
                title="Agent 产出 render_page / browser_page 等页面结果图时自动连入演进墙（严格排除 canvas_read 画布自读图）"
              >
                <input
                  type="checkbox"
                  checked={autoLineage}
                  onChange={e => {
                    const next = e.target.checked
                    setAutoLineage(next)
                    try { window.localStorage.setItem('fd:auto-lineage', next ? '1' : '0') } catch {}
                  }}
                />
                自动把页面结果图连入画布演进链
              </label>
            ) : null}
          </div>}
          <div className="fd-agent-transcript-wrap">
          <div
            className="fd-agent-transcript"
            ref={scroll}
            onWheel={event => {
              if (event.deltaY < 0) {
                programmaticScrollTopRef.current = null
                updateFollow(false)
              }
            }}
            onPointerDown={event => {
              pointerDownRef.current = true
              const el = event.currentTarget
              // 点在原生滚动条轨道/滑块上时立即解除自动贴底，避免拖滑块时被流式刷新抢回去
              if (event.target === el && event.clientX >= el.getBoundingClientRect().left + el.clientWidth) {
                programmaticScrollTopRef.current = null
                updateFollow(false)
              }
            }}
            onKeyDown={event => {
              if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
                programmaticScrollTopRef.current = null
                updateFollow(false)
              } else if (event.key === 'End') {
                updateFollow(true)
                scrollToBottom()
              }
            }}
            onScroll={event => {
              const el = event.currentTarget
              const currentTop = el.scrollTop
              if (programmaticScrollTopRef.current !== null && Math.abs(currentTop - programmaticScrollTopRef.current) <= 1) {
                programmaticScrollTopRef.current = null
                lastScrollTopRef.current = currentTop
                return
              }
              programmaticScrollTopRef.current = null
              const prevTop = lastScrollTopRef.current
              lastScrollTopRef.current = currentTop

              const distanceFromBottom = el.scrollHeight - currentTop - el.clientHeight
              if (currentTop < prevTop - 1) {
                updateFollow(false)
              } else if (distanceFromBottom <= 12) {
                updateFollow(true)
              }
            }}
          >
            {state.busy && active && active.board !== board ? <p className="fd-agent-alert fd-agent-small">正在处理画板「{active.board}」的任务；本轮结束后可在当前画板发起任务。</p> : null}
            {!active?.runs.length ? (isAcp ? (
              <div className="fd-agent-empty fd-acp-empty">
                <div className="fd-agent-sketch fd-acp-sketch" aria-hidden="true">
                  <span>画布</span>
                  <i>⇄</i>
                  <span className="fd-acp-sketch-pill"><AcpAgentMark preset={acpPreset} />{acpBrand}</span>
                </div>
                <h3>直接在这里聊与画</h3>
                <p>通过本地 ACP 直连 {acpBrand}，当前画板的图文和选区会自动带上，画布 MCP 工具也已同步挂载。</p>
                <p className="fd-agent-small">选中元素时只发送选区；未选择时发送整块画板。落笔将以「@{seatName}」席位署名。</p>
                <div className="fd-acp-starters" aria-label="快捷开场示例">
                  {ACP_STARTERS.map(sample => (
                    <button
                      key={sample}
                      type="button"
                      className="fd-acp-starter"
                      disabled={disabled}
                      onClick={() => {
                        setGoal(sample)
                        composerRef.current?.focus()
                      }}
                    >
                      <span>✦</span>{sample}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="fd-agent-empty">
                <div className="fd-agent-sketch" aria-hidden="true"><span>想法</span><i>→</i><span>行动</span></div>
                <h3>从这一笔开始</h3>
                <p>画草图、圈出问题，或直接写下目标。Agent 会带着画布上下文开始工作。</p>
                <p className="fd-agent-small">选中元素时只发送选区；未选择时发送当前画板。需要操作文件时，请先选择项目目录。</p>
                {state.setupNeeded ? <button className="fd-agent-primary" onClick={() => setSettings(true)}>先连接模型</button> : null}
              </div>
            )) : active.runs.map((run, index) => {
              const usageText = run.status !== 'running' ? formatRunUsage(run.usage) : ''
              const plan = planDisplay(run, active.engine === 'acp')
              return <article className="fd-agent-run" key={run.id}>
              <div className="fd-agent-run-meta"><span>第 {index + 1} 轮 · {run.mode === 'plan' ? '规划' : run.mode === 'execute' ? '执行' : run.mode === 'resume' ? '续接' : '任务'}</span><span className={`fd-agent-run-status fd-agent-run-${run.status}`}>{LABEL[run.status]}</span></div>
              <p className="fd-agent-goal">{run.goal}</p>
              <Thinking run={run} />
              {run.tools.length ? <details className="fd-agent-tools"><summary>工具记录 · {run.tools.length} 项{run.tools.some(t => t.status === 'running') && run.status === 'running' ? ' · 正在执行' : ''}</summary>
                {run.tools.map((tool, toolIndex) => <details key={`${tool.id}/${toolIndex}`}><summary><span>{tool.status === 'completed' ? '✓' : tool.status === 'failed' ? '×' : '·'}</span> {toolDisplayName(tool.name, state.toolLabels)}{tool.autoApproved ? <span className="fd-agent-small" title="按规则自动放行，没有弹窗确认"> · 自动放行（{AUTO_APPROVED[tool.autoApproved] ?? tool.autoApproved}）</span> : null}</summary><pre>{tool.input}{tool.result ? `\n\n${tool.result}` : ''}</pre></details>)}
              </details> : null}
              <RoundChangesView run={run} />
              {run.images?.map(image => <ResultImage key={image.id} image={image} placed={Boolean(placedImageIds?.has(image.id))} disabled={working || state.busy || active?.board !== board} onPreview={(src, alt) => setPreviewSrc({ src, alt })} onInsert={dataURL => act(() => insertImage(image, dataURL, { annotations: run.annotations, seat: seatName }))} onLoaded={() => { if (follow.current && !pointerDownRef.current) scrollToBottom() }} />)}
              {plan ? <div className="fd-agent-plan"><strong>{run.status === 'planned' ? '待确认的计划' : '本轮计划'}</strong><AgentMarkdown text={plan.body} />
                {plan.note ? <div className="fd-agent-plan-note"><strong>补充说明</strong><AgentMarkdown text={plan.note} /></div> : null}
              </div> : null}
              {/* A plan's text is the model's reply; show it once, inside the plan box. */}
              {run.reply && !run.plan ? <div className="fd-agent-reply"><AgentMarkdown text={run.reply} /></div> : null}
              {run.draft ? <div className="fd-agent-reply fd-agent-draft"><AgentMarkdown text={run.draft} draft /></div> : null}
              {run.verificationWarning ? <p className="fd-agent-small fd-agent-warning">{run.verificationWarning}</p> : null}
              {run.status === 'unverified' && !run.verificationWarning ? <p className="fd-agent-small">本轮已结束，仍有结果未经独立检查，请结合产物确认。</p> : null}
              {run.status === 'needs_review' || (run.status === 'unverified' && run.compareImageId) ? <ReviewBox
                run={run}
                disabled={working || state.busy}
                onShow={() => {
                  const image = run.images?.find(img => img.id === run.compareImageId)
                  if (!image) return
                  void act(async () => insertImage(image, await api.image(image.id), { annotations: run.annotations, seat: seatName }))
                }}
                onDecide={(verdict, note) => act(() => api.review(run.id, verdict, note))}
              /> : null}
              {run.review ? <p className="fd-agent-small">{run.review.verdict === 'approved' ? '你已确认改对了。' : `你标记了没改对${run.review.note ? `：${run.review.note}` : ''}；下一轮会带上这条说明。`}</p> : null}
              {run.error ? <p className="fd-agent-error">{run.error}</p> : null}
              {run.status !== 'running' ? <div className="fd-agent-run-foot">
                <span className={`fd-agent-run-status fd-agent-run-${run.status}`}>{LABEL[run.status]}</span>
                {usageText ? <span className="fd-agent-run-usage">{usageText}</span> : null}
              </div> : null}
            </article>})}
          </div>
          {!following && state.busy ? (
            <button
              type="button"
              className="fd-agent-jump-bottom"
              onClick={() => {
                updateFollow(true)
                scrollToBottom()
              }}
            >
              ↓ 回到最新输出
            </button>
          ) : null}
          </div>
          {currentApproval ? (() => {
            // ACP 审批：两个允许按钮都只向代理选「允许一次」，本任务内的记忆由宿主自己做；
            // 代理只给了永久授权时如实说明，单独给一个「始终允许」，不让「本次允许」偷偷变成永久授权
            const acpOptions = currentApproval.options
            const onlyPermanent = Boolean(acpOptions && !acpAllowOnceOption(acpOptions))
            const permanent = acpOptions?.find(o => o.kind === 'allow_always')
            const canRemember = acpOptions ? Boolean(currentApproval.ruleKey) && !onlyPermanent : Boolean(currentApproval.preview)
            return <div className="fd-agent-approval" key={currentApproval.requestId} role="group" aria-label="工具审批">
              <strong><span>允许这项操作？</span>{approvals.length > 1 ? <span className="fd-agent-small">1 / {approvals.length}</span> : null}</strong>
              <span>{toolDisplayName(currentApproval.name, state.toolLabels)}</span><pre>{currentApproval.description}</pre>
              {onlyPermanent ? <p className="fd-agent-small fd-agent-approval-warn" role="note">
                {acpBrand} 这次只提供永久授权，没有「只允许这一次」。选「始终允许」后，{acpBrand} 会在它自己的设置里长期放行这类操作，Flying draws 无法替你撤销；不确定就拒绝。
              </p> : null}
              <div>
                <button disabled={working} onClick={() => void act(() => api.approve(currentApproval.requestId, false))}>拒绝</button>
                {onlyPermanent
                  ? (permanent ? <button className="fd-agent-stop" disabled={working} title={`选「${permanent.name}」：由 ${acpBrand} 永久记住`} onClick={() => void act(() => api.approve(currentApproval.requestId, true, false, true))}>始终允许（{acpBrand} 永久记住）</button> : null)
                  : <>
                      {canRemember ? <button disabled={working} title="之后这个任务里参数完全相同的同一调用直接执行，不再询问；可在任务里清空" onClick={() => void act(() => api.approve(currentApproval.requestId, true, true))}>本任务内都允许</button> : null}
                      <button className="fd-agent-primary" disabled={working} onClick={() => void act(() => api.approve(currentApproval.requestId, true))}>本次允许</button>
                    </>}
              </div>
            </div>
          })() : null}
          {active?.allowedCommands?.length && !currentApproval ? <p className="fd-agent-small fd-agent-allowed">
            本任务内已允许 {active.allowedCommands.length} 条调用不再询问
            <button className="fd-agent-link" disabled={working} title={active.allowedCommands.map(rule => `${toolDisplayName(rule.name, state.toolLabels)}：${rule.input}`).join('\n')} onClick={() => void act(() => api.clearAllowedCommands())}>清空</button>
          </p> : null}
          {resumeFailure || readOnlyTask ? <div className="fd-agent-alert fd-agent-resume" role="alert">
            <p>{readOnlyTask?.message ?? resumeFailure?.message}</p>
            <div>
              {!readOnlyTask && resumeFailure?.reason === 'error' ? <button type="button" disabled={working || state.busy} title="再次向代理提交原会话 ID" onClick={() => void act(() => api.openTask(resumeFailure.itemId))}>重试恢复</button> : null}
              <button type="button" className="fd-agent-primary" disabled={working || state.busy} title="原任务记录保留，新消息会进入一项独立的新任务" onClick={() => void act(() => api.newTask(board))}>开始新任务</button>
            </div>
          </div> : null}
          {alertError ? <div className="fd-agent-error fd-agent-alert" role="alert">{alertError}</div> : null}
          {state.connection === 'ready' && telemetry ? <TelemetryBar telemetry={telemetry} /> : null}
          <div className="fd-agent-composer">
            {state.connection !== 'ready' ? (
              <div className="fd-agent-offline-actions">
                <button className="fd-agent-primary" disabled={state.connection === 'starting' || working} onClick={() => void act(() => api.connect(board))}>
                  {state.connection === 'starting' ? '连接中…' : isAcp ? '重新连接 ACP' : '重新连接内核'}
                </button>
                {isAcp ? (
                  <button type="button" disabled={working} onClick={() => openSettingsPanel(true)}>配置 ACP 路径</button>
                ) : null}
              </div>
            ) : <>
              {canResume ? <select className="fd-agent-continuation" aria-label="后续任务方式" disabled={working || state.busy} value={continuation} onChange={e => setContinuation(e.target.value as 'resume' | 'new')}>
                <option value="resume">继续原任务 · 沿用目标与预算</option><option value="new">同会话新目标 · 重新计预算</option>
              </select> : null}
              {!state.vision && !state.setupNeeded ? <div className="fd-agent-small">当前模型未启用图片，本轮只发送画布结构。</div> : null}
              {!state.setupNeeded ? <div className="fd-agent-scope">
                <span>发送范围：{selectedCount > 0 ? `已选 ${selectedCount} 项（自动带上重叠底图）` : '整块画板'}</span>
                {selectedCount > 0 && onClearSelection ? <button type="button" disabled={state.busy} onClick={onClearSelection}>取消选区</button> : null}
              </div> : null}
              {selectedImage && !state.setupNeeded ? <div className="fd-agent-trace">
                <span>已选中一张图片{state.vision ? '' : '（当前模型不支持看图，无法转换）'}</span>
                <button disabled={disabled || !state.vision || taskLocked} title={`让 ${seatName} 照着这张图画出可编辑的方框、文字和线条，确认后才落到画布上`} onClick={() => void traceSelected()}>转成可编辑图 ↗</button>
              </div> : null}
              <textarea ref={composerRef} aria-label="任务目标" placeholder={readOnlyTask ? '原工作目录已不存在，记录只能查看：请先点上方「开始新任务」' : resumeFailure ? (resumeFailure.reason === 'error' ? '原会话未恢复：请先点上方「重试恢复」或「开始新任务」' : '原会话只能查看：请先点上方「开始新任务」') : last?.status === 'planned' ? '可补充调整，Enter 确认执行，Shift+Enter 换行' : isAcp ? `对 ${acpBrand} 说点什么，或圈出画布再发…（Enter 发送，Shift+Enter 换行）` : '想让 Agent 做什么？（Enter 发送，Shift+Enter 换行）'} value={goal} disabled={state.busy || state.setupNeeded || taskLocked} onChange={e => setGoal(e.target.value)} onKeyDown={e => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return
                if (e.key === 'Enter' && !e.shiftKey && !e.altKey) { e.preventDefault(); if (taskLocked) return; if (last?.status === 'planned') void execute(); else void send() }
              }} rows={3} />
              <div className="fd-agent-actions">
                {resumePrevious ? <span className="fd-agent-small">沿用原任务的目标与预算</span> : <label className="fd-agent-check" title={planSupported ? undefined : `${acpBrand} 没有提供规划模式，只能直接执行`}><input type="checkbox" checked={planFirst && planSupported} disabled={disabled || !planSupported} onChange={e => setPlanFirst(e.target.checked)} />先拟计划</label>}
                {state.busy ? <button className="fd-agent-stop" disabled={working} onClick={() => void act(() => api.cancel())}>停止</button>
                  : last?.status === 'planned' ? <button className="fd-agent-primary" disabled={disabled || taskLocked} onClick={() => void execute()}>确认并执行 ↗</button>
                    : <button className="fd-agent-primary" disabled={disabled || state.setupNeeded || !goal.trim() || taskLocked} onClick={() => void send()}>{resumePrevious ? '继续原任务' : planFirst && planSupported ? '拟定计划' : '开始执行'} ↗</button>}
              </div>
            </>}
          </div>
        </>
      )}
      {previewSrc ? (
        <div
          className="fd-agent-lightbox"
          role="dialog"
          aria-label="结果图片大图预览"
          onClick={() => setPreviewSrc(null)}
          onKeyDown={e => { if (e.key === 'Escape') setPreviewSrc(null) }}
          tabIndex={-1}
        >
          <img src={previewSrc.src} alt={previewSrc.alt} />
        </div>
      ) : null}
    </aside>
  )
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

const CHANGE_MARK: Record<RoundFileChange['status'], string> = { added: '新增', modified: '修改', deleted: '删除' }

const lineCount = (file: Pick<RoundFileChange, 'additions' | 'deletions'>): string =>
  file.additions === null || file.deletions === null ? '二进制' : `+${file.additions} −${file.deletions}`

/** 本轮改动：和本轮开始前的工作区快照比，不含开始前就有的未提交改动。点文件看差异。 */
function RoundChangesView({ run }: { run: AgentRun }) {
  const changes = run.roundChanges
  if (!changes) {
    // 没有快照时只在确实改了文件的轮次说明一句，免得每轮都提示
    return run.roundChangesNote && run.status !== 'running' && run.changedFiles?.length ? <p className="fd-agent-small">{run.roundChangesNote}</p> : null
  }
  return <details className="fd-agent-tools fd-agent-changes">
    <summary>本轮改动 · {changes.total ? `${changes.total} 个文件 · +${changes.additions} −${changes.deletions}` : '没有改动文件'}</summary>
    {changes.preexisting ? <p className="fd-agent-small">开始前工作区已有 {changes.preexisting} 个文件没提交的改动，没算在本轮里。</p> : null}
    {changes.mode === 'plain' ? <p className="fd-agent-small">工作目录不是 git 仓库，按普通文件夹比对；依赖、构建产物、虚拟环境等目录不计入。</p> : null}
    {changes.skippedLarge ? <p className="fd-agent-small">有 {changes.skippedLarge} 个超过 50 MB 的未跟踪文件没进快照，它们的变化这里看不到。</p> : null}
    {changes.pruned ? <p className="fd-agent-small">这一轮的差异已按保留策略清理（每个项目保留最近 50 轮），只剩文件列表。</p> : null}
    {changes.files.map(file => changes.pruned
      ? <p key={file.path} className="fd-agent-change-row"><span className={`fd-agent-change-${file.status}`}>{CHANGE_MARK[file.status]}</span> {file.path} <span className="fd-agent-small">{lineCount(file)}</span></p>
      : <FileDiff key={file.path} runId={run.id} file={file} />)}
    {changes.total > changes.files.length ? <p className="fd-agent-small">还有 {changes.total - changes.files.length} 个文件没列出。</p> : null}
  </details>
}

function FileDiff({ runId, file }: { runId: string; file: RoundFileChange }) {
  const [patch, setPatch] = useState<string | null>(null)
  return <details onToggle={event => {
    if (!(event.currentTarget as HTMLDetailsElement).open || patch !== null) return
    setPatch('读取中…')
    void window.flyingdraws.agent.roundDiff(runId, file.path).then(
      text => setPatch(text || '（没有文本差异）'),
      error => setPatch(`差异读取失败：${error instanceof Error ? error.message : String(error)}`)
    )
  }}>
    <summary><span className={`fd-agent-change-${file.status}`}>{CHANGE_MARK[file.status]}</span> {file.path} <span className="fd-agent-small">{lineCount(file)}</span></summary>
    {patch === null ? null : <pre className="fd-agent-diff">{patch.split('\n').map((line, index) => <span key={index} className={
      line.startsWith('+') && !line.startsWith('+++') ? 'fd-diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'fd-diff-del' : line.startsWith('@@') ? 'fd-diff-hunk' : undefined
    }>{line}{'\n'}</span>)}</pre>}
  </details>
}

/** 视觉改动的核对：对照图已经在画布上和圈选原图并排，用户看一眼给结论。 */
function ReviewBox({ run, disabled, onShow, onDecide }: {
  run: AgentRun
  disabled: boolean
  onShow(): void
  onDecide(verdict: 'approved' | 'rejected', note?: string): Promise<boolean>
}) {
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  return <div className="fd-agent-review" role="group" aria-label="核对改动">
    <strong>看一眼对不对</strong>
    <p className="fd-agent-small">改后截图已放在圈选原图右边，虚线框是你圈的位置。{run.compareImageId ? '' : '本轮没有拍到改后截图。'}</p>
    {rejecting ? <>
      <textarea aria-label="哪里没改对" rows={2} placeholder="哪里不对？例如：血条压住了怪物眼睛（可不填）" value={note} onChange={e => setNote(e.target.value)} />
      <div>
        <button disabled={disabled} onClick={() => setRejecting(false)}>返回</button>
        <button className="fd-agent-primary" disabled={disabled} onClick={() => void onDecide('rejected', note)}>记下，下一轮接着改</button>
      </div>
    </> : <div>
      {run.compareImageId ? <button disabled={disabled} onClick={onShow}>在画布上看</button> : null}
      <button disabled={disabled} onClick={() => setRejecting(true)}>没改对…</button>
      <button className="fd-agent-primary" disabled={disabled} onClick={() => void onDecide('approved')}>改对了 ✓</button>
    </div>}
  </div>
}

function TelemetryBar({ telemetry }: { telemetry: AgentTelemetry }) {
  const ctx = telemetry.contextTokens ?? 0
  const limit = telemetry.contextLimit ?? 0
  const hasLimit = limit > 0
  const rawPct = hasLimit ? (ctx / limit) * 100 : 0
  const pct = hasLimit ? Math.max(0, Math.round(rawPct)) : 0
  const fillPct = hasLimit ? Math.min(100, Math.max(0, rawPct)) : 0
  const level = pct >= 90 ? 'fd-agent-telemetry-danger' : pct >= 75 ? 'fd-agent-telemetry-warn' : ''
  const obs = telemetry.cacheObservations ?? 0
  const hit = telemetry.cacheHitRate
  const hasCache = typeof hit === 'number' && obs > 0
  const spent = telemetry.spentTokens ?? 0
  const reqs = telemetry.requestsUsed ?? 0

  return (
    <div className="fd-agent-telemetry" aria-label="上下文与用量">
      <div className="fd-agent-telemetry-row">
        <span
          className={level || undefined}
          title={hasLimit ? `当前上下文 ${ctx.toLocaleString()} / ${limit.toLocaleString()} tokens` : ctx > 0 ? `当前上下文 ${ctx.toLocaleString()} tokens` : '尚未收到上下文统计'}
        >
          {hasLimit ? `上下文 ${formatTokens(ctx)} / ${formatTokens(limit)} (${pct}%)` : ctx > 0 ? `上下文 ${formatTokens(ctx)}` : '上下文 —'}
        </span>
        <div className="fd-agent-telemetry-items">
          <span title={hasCache ? `提示词缓存命中率（已观测 ${obs} 次请求）` : `已观测 ${obs} 次请求`}>
            {hasCache ? `缓存命中 ${Math.round(hit * 100)}%` : '缓存 —'}
          </span>
          {spent > 0 ? (
            <span title={reqs > 0 ? `本轮消耗 ${spent.toLocaleString()} tokens（${reqs} 次调用）` : `本轮消耗 ${spent.toLocaleString()} tokens`}>
              消耗 {formatTokens(spent)}
            </span>
          ) : null}
        </div>
      </div>
      {hasLimit ? (
        <div className="fd-agent-telemetry-bar" aria-hidden="true">
          <div className={`fd-agent-telemetry-fill${level ? ` ${level}` : ''}`} style={{ width: `${fillPct}%` }} />
        </div>
      ) : null}
    </div>
  )
}

function ResultImage({
  image,
  placed = false,
  disabled,
  onPreview,
  onInsert,
  onLoaded
}: {
  image: AgentResultImage
  placed?: boolean
  disabled: boolean
  onPreview(src: string, alt: string): void
  onInsert(dataURL: string): Promise<boolean>
  onLoaded?: () => void
}) {
  const [dataURL, setDataURL] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inserted, setInserted] = useState(false)
  useEffect(() => {
    if (!placed) setInserted(false)
  }, [placed])
  useEffect(() => {
    let live = true
    void window.flyingdraws.agent.image(image.id).then(data => { if (live) setDataURL(data) }, () => { if (live) setError('图片读取失败') })
    return () => { live = false }
  }, [image.id])
  const captionParts = ['结果图片']
  if (image.meta?.naturalWidth && image.meta?.naturalHeight) captionParts.push(`${image.meta.naturalWidth}×${image.meta.naturalHeight}`)
  if (image.meta?.round) captionParts.push(`第 ${image.meta.round} 轮`)
  if (image.meta?.changedFiles?.length) captionParts.push(image.meta.changedFiles.slice(0, 2).join(', '))
  const onCanvas = placed || inserted
  return <figure className="fd-agent-result-image">
    {dataURL ? <img src={dataURL} alt={image.name} title="点击查看大图" onLoad={onLoaded} onClick={() => onPreview(dataURL, image.name)} /> : <span>{error || '读取结果图片…'}</span>}
    <figcaption>
      <span title={image.meta?.url || image.meta?.sourcePath || image.name}>{captionParts.join(' · ')}</span>
      <button disabled={disabled || !dataURL} onClick={() => {
        if (!dataURL) return
        void onInsert(dataURL).then(ok => { if (ok) setInserted(true) })
      }}>{onCanvas ? '放到画布 ✓' : '放到画布 ↗'}</button>
    </figcaption>
  </figure>
}
