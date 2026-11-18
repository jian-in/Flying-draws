/** The built-in agent's seat on the canvas: its tools, drawings and inserted images all use this name. */
export const AGENT_SEAT = 'Fuxi'

export interface ProviderChoice { provider: string; model: string; ready: boolean }
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
export interface AgentApproval { requestId: string; name: string; description: string; answered: boolean }
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
}
export interface AgentWorkItem {
  id: string
  board: string
  cwd: string
  sessionId: string
  title: string
  archived?: boolean
  runs: AgentRun[]
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
  /** Kernel tool name → readable name (MCP tools are numbered inside the kernel). */
  toolLabels?: Record<string, string>
  workspace: string
  /** 内核把截图、job 日志放在哪：host = 应用数据目录（不写进项目），旧内核没有这一项 */
  toolStorage?: { mode: string; artifactsDir?: string; jobsDir?: string }
  activeItemId: string | null
  items: AgentWorkItem[]
}
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
  selectModel(provider: string, model: string): Promise<void>
  chooseWorkspace(board: string): Promise<string | null>
  newTask(board: string): Promise<void>
  openTask(id: string): Promise<void>
  submit(input: AgentSubmission): Promise<void>
  execute(text: string): Promise<void>
  cancel(): Promise<void>
  approve(requestId: string, approved: boolean): Promise<void>
  review(runId: string, verdict: AgentRunReview['verdict'], note?: string): Promise<void>
  image(id: string): Promise<string>
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
