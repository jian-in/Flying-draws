/** The built-in Fuxi agent's seat on the canvas: its tools, drawings and inserted images use this name. */
export const AGENT_SEAT = 'Fuxi'
/** Default canvas seat name when running via Antigravity / external ACP backend. */
export const DEFAULT_ACP_SEAT = 'Antigravity'

export type AgentEngine = 'fuxi' | 'acp'
export type AcpPresetId = 'antigravity' | 'claude' | 'codex' | 'opencode' | 'custom'
export type BuiltinAcpPresetId = Exclude<AcpPresetId, 'custom'>

export interface AcpPresetSpec {
  id: BuiltinAcpPresetId
  label: string
  shortLabel: string
  defaultSeat: string
  defaultArgs: string[]
  installHint: string
  loginHint: string
}

export const ACP_PRESETS: readonly AcpPresetSpec[] = [
  {
    id: 'antigravity',
    label: 'Antigravity',
    shortLabel: 'Antigravity',
    defaultSeat: 'Antigravity',
    defaultArgs: ['acp'],
    installHint: '安装 Antigravity CLI（agy）',
    loginHint: 'agy acp --login'
  },
  {
    id: 'claude',
    label: 'Claude Code',
    shortLabel: 'Claude',
    defaultSeat: 'Claude',
    defaultArgs: [],
    installHint: 'npm i -g @agentclientprotocol/claude-agent-acp',
    loginHint: 'claude login'
  },
  {
    id: 'codex',
    label: 'Codex',
    shortLabel: 'Codex',
    defaultSeat: 'Codex',
    defaultArgs: [],
    installHint: 'npm i -g @agentclientprotocol/codex-acp',
    loginHint: 'codex login'
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    shortLabel: 'OpenCode',
    defaultSeat: 'OpenCode',
    defaultArgs: ['acp'],
    installHint: 'npm i -g opencode-ai',
    loginHint: 'opencode auth login'
  }
]

export function acpPresetSpec(id?: AcpPresetId): AcpPresetSpec | undefined {
  return ACP_PRESETS.find(p => p.id === id)
}

export interface AcpBackendConfig {
  /** 预设 ID（antigravity / claude / codex / opencode / custom）。 */
  preset?: AcpPresetId
  /** Executable path or command name; empty string auto-detects the preset's local CLI. */
  command: string
  /** CLI arguments passed to the ACP executable. */
  args: string[]
  /** Canvas seat/author name used for drawings and inserted images under ACP. */
  seat: string
  /** Friendly display name shown in the side panel header. */
  label?: string
}

export const DEFAULT_ACP_CONFIG: AcpBackendConfig = {
  preset: 'antigravity',
  command: '',
  args: ['acp'],
  seat: DEFAULT_ACP_SEAT,
  label: 'Antigravity'
}

export interface AcpSelectOption {
  value: string
  name: string
  description?: string
}

export interface AcpConfigOption {
  id: string
  name: string
  category?: string
  currentValue: string
  options: AcpSelectOption[]
}

export interface AcpModeInfo {
  id: string
  name: string
  description?: string
}

export interface AcpRuntimeInfo {
  preset?: AcpPresetId
  name: string
  version?: string
  tier?: string
  command?: string
  detectedCommand?: string | null
  detectedPresets?: Partial<Record<BuiltinAcpPresetId, string | null>>
  modes?: AcpModeInfo[]
  currentModeId?: string
  configOptions?: AcpConfigOption[]
}

/** 代理声明的规划模式从哪里切：configOptions 里的 mode 选项优先，其次是 session modes；都没有就不能先拟计划。 */
export type AcpPlanTarget = { via: 'config'; configId: string } | { via: 'mode' }
export const ACP_PLAN_MODE = 'plan'

export function acpPlanTarget(acp?: Pick<AcpRuntimeInfo, 'modes' | 'configOptions'> | null): AcpPlanTarget | null {
  const modeOpt = acp?.configOptions?.find(o => o.id === 'mode' || o.category === 'mode')
  if (modeOpt?.options.some(o => o.value === ACP_PLAN_MODE)) return { via: 'config', configId: modeOpt.id }
  if (acp?.modes?.some(m => m.id === ACP_PLAN_MODE)) return { via: 'mode' }
  return null
}

/** 规划前要恢复到的模式缺失时，挑一个非规划模式兜底。 */
export function acpFallbackMode(acp: Pick<AcpRuntimeInfo, 'modes' | 'configOptions'> | null | undefined, target: AcpPlanTarget): string | undefined {
  const values = target.via === 'config'
    ? acp?.configOptions?.find(o => o.id === target.configId)?.options.map(o => o.value) ?? []
    : acp?.modes?.map(m => m.id) ?? []
  return values.includes('default') ? 'default' : values.find(v => v !== ACP_PLAN_MODE)
}

/** ACP 历史会话没能恢复：保留原任务和会话 ID，等用户重试或另开新任务。 */
export interface AcpResumeFailure {
  itemId: string
  /** unsupported：代理没有恢复能力；error：恢复请求报错，可重试 */
  reason: 'unsupported' | 'error'
  message: string
}

/** 用户主动打开的历史任务只能查看（目前是它的工作目录已不存在）；两种引擎通用。 */
export interface ReadOnlyTask {
  itemId: string
  message: string
}

export interface ProviderChoice { provider: string; model: string; ready: boolean; label?: string }
export interface ProviderDraft {
  protocol: 'openai-compatible' | 'anthropic-messages' | 'gemini'
  name: string
  base_url: string
  credential: string
  model: string
  context_window: number
  max_tokens: number
  vision: boolean
}
/** 设置面板拉取模型列表用：只带端点需要的字段，不带其它设置 */
export interface ProviderModelQuery {
  protocol: ProviderDraft['protocol']
  base_url: string
  credential: string
}
export interface AgentCapture {
  sceneJson: string
  pngBase64: string | null
  selectedIds: string[]
}
export interface AgentTool {
  id: string
  name: string
  input: string
  status: 'running' | 'completed' | 'failed'
  result?: string
  /** 内核按只读规则自动放行、没有弹审批（目前只有 readonly_shell） */
  autoApproved?: string
}
export interface ImageSourceMeta {
  naturalWidth: number
  naturalHeight: number
  url?: string
  sourcePath?: string
  viewport?: { w: number; h: number }
  workItemId?: string
  taskId?: string
  runId?: string
  round?: number
  tool?: string
  sourceImageRef?: string
  changedFiles?: string[]
  capturedAt?: string
  /** 拍这张图之前，本轮已经改过文件（用来挑「改后」对照图）。 */
  afterEdit?: boolean
}
export interface ImageRegionAnnotation {
  imageId: string
  imageRef: string
  resultImageId?: string
  pixelBbox: { x: number; y: number; w: number; h: number }
  naturalSize: { w: number; h: number }
  kind: 'loop' | 'box' | 'arrow' | 'stroke_group' | 'text'
  annotatorId: string
  note?: string | null
  url?: string
}
export interface AgentApproval {
  requestId: string
  name: string
  description: string
  answered: boolean
  /** 内核在描述里给出的实际参数（「操作预览」那一行），用来认出同一条命令 */
  preview?: string
  /** 宿主按「本任务内都允许」自动批准了，没有弹给用户 */
  autoApproved?: boolean
  /** ACP 后端返回的可选审批选项 */
  options?: { id: string; name: string; kind?: string }[]
  /** ACP：由工具身份和完整参数算出的匹配键；没有完整参数时不给，这条调用就不能记住 */
  ruleKey?: string
}
/**
 * 用户在某个任务里选了「本任务内都允许」的一条工具调用：工具名和参数要一字不差才算同一条。
 * input 只用于展示（ACP 的预览最多 8000 字符）；ACP 规则按 key 匹配，没有 key 的旧 ACP 规则不再自动放行。
 */
export interface AllowedCommand { name: string; input: string; key?: string }

/** ACP 审批选项里能代表「只允许这一次」的那项；代理只给了永久授权时返回 undefined。 */
export function acpAllowOnceOption<T extends { id: string; name: string; kind?: string }>(options: readonly T[]): T | undefined {
  return options.find(o => o.kind === 'allow_once')
    ?? options.find(o => !o.kind && !/always|永久|始终|reject|deny|拒绝/i.test(`${o.id} ${o.name}`))
}
export interface AgentResultImage {
  id: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  name: string
  meta?: ImageSourceMeta
}
export type RunStatus =
  | 'running' | 'planned' | 'completed' | 'unverified' | 'cancelled' | 'failed' | 'interrupted'
  /** 视觉改动已拍了改后截图，等用户看一眼对照图再定 */
  | 'needs_review'
  /** 用户看过对照图，说没改对 */
  | 'rejected'
export interface AgentTelemetry {
  contextTokens: number
  contextLimit: number
  cacheHitRate: number | null
  cacheObservations: number
  requestsUsed?: number
  spentTokens?: number
  estimatedCost?: number | null
}
export interface AgentRunUsage {
  spentTokens: number
  requestsUsed: number
  cacheHitRate?: number | null
  cacheObservations?: number
  contextTokens?: number
  contextLimit?: number
  estimatedCost?: number | null
}
export interface AgentRunReview {
  verdict: 'approved' | 'rejected'
  note?: string
  decidedAt: string
}
export interface AgentRun {
  id: string
  taskId?: string
  mode: 'direct' | 'plan' | 'execute' | 'resume'
  status: RunStatus
  goal: string
  startedAt: string
  endedAt?: string
  reply: string
  draft: string
  /** Model reasoning shown folded; `thinkingDraft` is the part still streaming. */
  thinking?: string
  thinkingDraft?: string
  plan?: string
  error?: string
  outcome?: Record<string, unknown>
  tools: AgentTool[]
  approvals: AgentApproval[]
  images?: AgentResultImage[]
  annotations?: ImageRegionAnnotation[]
  sourceImageRef?: string
  changedFiles?: string[]
  /** 本轮用来和改前圈选图对照的那张改后截图（只自动上墙这一张） */
  compareImageId?: string
  /** 宿主对证据的提醒，例如改了文件却没拍改后截图 */
  verificationWarning?: string
  /** 用户看过对照图后的结论 */
  review?: AgentRunReview
  /** 本轮开始前工作区的快照（git 仓库或普通文件夹；拍不成就没有） */
  baseline?: RoundBaseline
  /** 本轮结束时和开始前快照的差异：只算这一轮的改动，不含开始前就有的未提交改动 */
  roundChanges?: RoundChanges
  /** 没能按快照统计本轮改动的原因（不是 git 仓库、快照失败等） */
  roundChangesNote?: string
  /** 本轮消耗的 token、调用次数与上下文/缓存统计 */
  usage?: AgentRunUsage
}
/** git：工作目录在 git 仓库里；plain：普通文件夹，快照库自己当 git 目录来拍 */
export type SnapshotMode = 'git' | 'plain'
export interface RoundBaseline {
  /** 仓库根目录（plain 模式是工作目录本身） */
  root: string
  /** 不写就是 git */
  mode?: SnapshotMode
  /** 开始前工作区（含未跟踪、不含被忽略文件）写成的树 */
  tree: string
  /** 开始前相对 HEAD 已有改动的文件数，这些不算在本轮里（plain 模式总是 0） */
  preexisting: number
  /** 超过 50 MB、没进快照的未跟踪文件数 */
  skippedLarge?: number
  capturedAt: string
}
export interface RoundFileChange {
  /** 相对仓库根目录的路径，正斜杠 */
  path: string
  status: 'added' | 'modified' | 'deleted'
  /** 二进制文件没有行数 */
  additions: number | null
  deletions: number | null
}
export interface RoundChanges {
  root: string
  mode?: SnapshotMode
  before: string
  after: string
  /** 最多列 200 个，total 是实际总数 */
  files: RoundFileChange[]
  total: number
  additions: number
  deletions: number
  preexisting: number
  /** 超过 50 MB、没进快照的未跟踪文件数（这些文件的变化看不到） */
  skippedLarge?: number
  /** 按保留策略清理了快照，只剩文件列表，看不了差异 */
  pruned?: boolean
}
export interface AgentWorkItem {
  id: string
  board: string
  cwd: string
  sessionId: string
  title: string
  /** 所属执行后端；缺省视为历史 Fuxi 任务 */
  engine?: AgentEngine
  /** ACP 模式下所属预设（避免跨 Agent 误续接会话 ID） */
  acpPreset?: AcpPresetId
  archived?: boolean
  runs: AgentRun[]
  /** 本任务内已允许、不再询问的工具调用 */
  allowedCommands?: AllowedCommand[]
}
export interface AgentState {
  connection: 'offline' | 'starting' | 'ready' | 'error'
  error: string | null
  recordsWarning?: string
  workspaceWarning?: string
  busy: boolean
  setupNeeded: boolean
  vision: boolean
  provider: string
  model: string
  choices: ProviderChoice[]
  /** 当前启用的 Agent 后端：fuxi（内置）或 acp（Antigravity / 标准 ACP） */
  engine?: AgentEngine
  /** 当前后端在画布上使用的席位名称 */
  seat?: string
  /** ACP 后端配置（持久化在 host-settings.json） */
  acpConfig?: AcpBackendConfig
  /** 各 ACP 预设已保存的独立配置（供设置面板切换预设卡片时回显） */
  acpProfiles?: Partial<Record<AcpPresetId, AcpBackendConfig>>
  /** ACP 后端运行时信息（版本、套餐、可用模式与配置项） */
  acp?: AcpRuntimeInfo
  /** ACP 历史会话恢复失败；有它时当前任务只能查看，发消息前要先重试恢复或开始新任务 */
  acpResume?: AcpResumeFailure
  /** 当前任务只能查看：记录照常显示，不能接着发消息，要先开始新任务 */
  readOnlyTask?: ReadOnlyTask
  /** Kernel tool name → readable name (MCP tools are numbered inside the kernel). */
  toolLabels?: Record<string, string>
  workspace: string
  /** 内核把截图、job 日志放在哪：host = 应用数据目录（不写进项目），旧内核没有这一项 */
  toolStorage?: { mode: string; artifactsDir?: string; jobsDir?: string }
  /** 工具审批模式：auto-safe（默认，按风险询问）或 full-access（YOLO，全部自动执行、不再询问）。YOLO 只在本次运行内有效，重启应用回到 auto-safe。 */
  approvalMode: ApprovalMode
  /** 当前会话的实时上下文窗口、缓存命中率与消耗统计 */
  telemetry?: AgentTelemetry
  activeItemId: string | null
  items: AgentWorkItem[]
}

export function activeAgentSeat(state?: Pick<AgentState, 'seat' | 'engine' | 'acpConfig'>): string {
  if (state?.seat?.trim()) return state.seat.trim()
  if (state?.engine === 'acp') return state.acpConfig?.seat?.trim() || DEFAULT_ACP_SEAT
  return AGENT_SEAT
}
export type ApprovalMode = 'auto-safe' | 'full-access'
export interface AgentSubmission {
  board: string
  goal: string
  capture: AgentCapture
  mode: 'direct' | 'plan'
  resume?: boolean
  /** 任务记录里显示的目标；不给就显示 goal。固定指令（如转成可编辑图）用它显示一句短的。 */
  display?: string
}
export interface AgentApi {
  state(): Promise<AgentState>
  connect(board: string): Promise<void>
  configure(draft: ProviderDraft): Promise<void>
  /** 从服务商拉取可选模型 ID；只读请求，不发任务 */
  models(query: ProviderModelQuery): Promise<string[]>
  selectModel(provider: string, model: string): Promise<void>
  setEngine(engine: AgentEngine, board: string, acpConfig?: Partial<AcpBackendConfig>): Promise<void>
  setAcpConfig(config: Partial<AcpBackendConfig>, board: string): Promise<void>
  setAcpConfigOption(configId: string, value: string): Promise<void>
  setApprovalMode(mode: ApprovalMode): Promise<void>
  chooseWorkspace(board: string): Promise<string | null>
  newTask(board: string): Promise<void>
  openTask(id: string): Promise<void>
  deleteTask(id: string): Promise<void>
  submit(input: AgentSubmission): Promise<void>
  execute(text: string): Promise<void>
  cancel(): Promise<void>
  /**
   * remember：批准并在本任务内记住这条调用，之后一字不差的同一调用不再询问（由宿主记住，只向代理选「允许一次」）。
   * always：只在 ACP 代理没有提供「允许一次」时使用，明确选它的永久授权。
   */
  approve(requestId: string, approved: boolean, remember?: boolean, always?: boolean): Promise<void>
  /** 清空当前任务里「本任务内都允许」的记录 */
  clearAllowedCommands(): Promise<void>
  review(runId: string, verdict: AgentRunReview['verdict'], note?: string): Promise<void>
  image(id: string): Promise<string>
  /** 本轮某个文件（不给就是全部）的差异文本 */
  roundDiff(runId: string, path?: string): Promise<string>
  onState(fn: (state: AgentState) => void): () => void
}

const TOOL_NAMES: Record<string, string> = {
  read_file: '读取文件', write_file: '写入文件', edit_file: '修改文件', apply_patch: '应用补丁',
  grep: '搜索内容', glob: '查找文件', pwsh: '运行命令', bash: '运行命令', shell: '运行命令',
  read_image: '查看图片', web_fetch: '获取网页', run_tests: '运行测试', related_tests: '查找相关测试',
  git: 'Git', diff: '查看改动', repo_map: '仓库概览', inspect_project: '检查项目', todo: '待办清单',
  deliver_task: '交付结果', verify_artifact: '核对产物', render_page: '渲染页面', browser_page: '打开网页',
  canvas_read: '读取画布', canvas_list: '列出画板', canvas_open: '打开画板', canvas_draw: '在画布上画',
  canvas_propose: '提议画布修改', canvas_request: '请你画', canvas_wait: '等待画布', canvas_pass: '递画笔',
  canvas_rename: '重命名画板', canvas_delete: '删除画板'
}

/**
 * Readable name for a kernel tool. MCP tools are numbered inside the kernel
 * (`mcp_<server>_<n>`), so their real name comes from the labels the kernel
 * reports when the workspace opens (`server/remote_name`).
 */
export function toolDisplayName(name: string, labels?: Record<string, string>): string {
  const label = labels?.[name]
  const remote = label ? label.slice(label.lastIndexOf('/') + 1) : name
  if (TOOL_NAMES[remote]) return TOOL_NAMES[remote]
  if (label) return label
  const mcp = /^mcp_(.+)_(?:\d+|resources)$/.exec(name)
  return mcp ? `${mcp[1].replace(/_/g, '-')} 的外部工具` : name
}

const CANVAS_SELF_TOOLS = new Set([
  'canvas_read',
  'canvas_list',
  'canvas_open',
  'canvas_draw',
  'canvas_propose',
  'canvas_request',
  'canvas_wait',
  'canvas_pass',
  'canvas_rename',
  'canvas_delete'
])

/**
 * 判断某张结果图片是否属于「页面/产物渲染图」（如 `render_page`、`browser_page` 等非画布自读工具产物）。
 * `canvas_read` 等画布自身工具返回的是画布截图，严禁自动插回画布以免造成画中画死循环。
 */
export function shouldAutoPlaceResultImage(image: AgentResultImage, labels?: Record<string, string>): boolean {
  if (!image?.id) return false
  const rawTool = (image.meta?.tool ?? '').trim()
  if (!rawTool) return false
  const label = labels?.[rawTool] ?? ''
  const remote = (label ? label.slice(label.lastIndexOf('/') + 1) : rawTool.slice(rawTool.lastIndexOf('/') + 1)).toLowerCase()
  if (CANVAS_SELF_TOOLS.has(remote) || remote.startsWith('canvas_')) return false
  if (/^mcp_flying[_-]draws(?:_|$)/i.test(rawTool) || /^flying[_-]draws\//i.test(rawTool) || /^flying[_-]draws\//i.test(label)) {
    return false
  }
  const combined = `${rawTool} ${label} ${image.name ?? ''}`.toLowerCase()
  if (/(?:^|[^a-z0-9])canvas_(?:read|list|open|draw|propose|request|wait|pass|rename|delete)(?:[^a-z0-9]|$)/.test(combined)) {
    return false
  }
  return true
}

/**
 * 挑本轮用来对照的「改后」截图：只看页面/产物截图（不含画布自读图），
 * 优先最后一张在改过文件之后拍的，没有就取最后一张页面截图。
 */
export function pickCompareImage(run: Pick<AgentRun, 'images'>, labels?: Record<string, string>): AgentResultImage | undefined {
  const pages = (run.images ?? []).filter(image => shouldAutoPlaceResultImage(image, labels))
  return [...pages].reverse().find(image => image.meta?.afterEdit) ?? pages.at(-1)
}

/**
 * 视觉任务（本轮带着圈选的页面截图发出）的收尾状态：内核的 completed / unverified
 * 只说明测试和工具层面的证据，不代表看起来对。拍到了改后截图就交给用户看一眼；
 * 改了文件却没截图，明确提示缺对照证据。其他任务保持内核给的状态。
 */
export function resolveVisualStatus(
  run: Pick<AgentRun, 'annotations' | 'sourceImageRef' | 'images' | 'changedFiles'>,
  base: RunStatus,
  labels?: Record<string, string>
): { status: RunStatus; compareImageId?: string; warning?: string } {
  if (base !== 'completed' && base !== 'unverified') return { status: base }
  const visual = Boolean(run.annotations?.length || run.sourceImageRef)
  if (!visual) return { status: base }
  const compare = pickCompareImage(run, labels)
  if (compare) return { status: 'needs_review', compareImageId: compare.id }
  if (run.changedFiles?.length) return { status: 'unverified', warning: '改了文件，但没有拍改后的页面截图，没法和圈选的原图对照。' }
  return { status: base }
}

/**
 * 「转成可编辑图」交给 Agent 的目标。图片用稳定 id 引用（不随画板版本错位），
 * 坐标系就是随任务附上的那张图的像素尺寸。
 */
export function traceImageGoal(imageId: string, width: number, height: number): string {
  return [
    `把画布上选中的这张图片转成可编辑的画布元素。附图就是这张图的原图，像素 ${width}×${height}。`,
    `调用一次 canvas_propose，ops 里放一条 trace_image：image 填 ${JSON.stringify(imageId)}，space 填 {"w": ${width}, "h": ${height}}，坐标全部按附图像素来。`,
    '逐一写出图里的每个方框（位置、大小、形状、里面的文字、边框色、填充色、字号）、独立的文字，以及每条线和箭头（经过的点、箭头方向、是否虚线；连着方框的用 from/to 绑定到方框的 id）。',
    '文字照原样抄写，不翻译不改写；颜色用十六进制。看不清的地方照大概画，不要编造内容。不要改动或删除原图。',
    'question 写「这样转换对吗？可以直接在画布上调整」。提交后不用等待用户回答，简短说明转了哪些内容、哪里没把握，就结束。'
  ].join('\n')
}
