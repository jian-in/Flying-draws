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
}
export interface AgentApproval { requestId: string; name: string; description: string; answered: boolean }
export interface AgentResultImage { id: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; name: string }
export type RunStatus = 'running' | 'planned' | 'completed' | 'unverified' | 'cancelled' | 'failed' | 'interrupted'
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
  activeItemId: string | null
  items: AgentWorkItem[]
}
export interface AgentSubmission {
  board: string
  goal: string
  capture: AgentCapture
  mode: 'direct' | 'plan'
  resume?: boolean
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
  image(id: string): Promise<string>
  onState(fn: (state: AgentState) => void): () => void
}

const TOOL_NAMES: Record<string, string> = {
  read_file: '读取文件', write_file: '写入文件', edit_file: '修改文件', apply_patch: '应用补丁',
  grep: '搜索内容', glob: '查找文件', pwsh: '运行命令', bash: '运行命令', shell: '运行命令',
  read_image: '查看图片', web_fetch: '获取网页', run_tests: '运行测试', related_tests: '查找相关测试',
  git: 'Git', diff: '查看改动', repo_map: '仓库概览', inspect_project: '检查项目', todo: '待办清单',
  deliver_task: '交付结果', verify_artifact: '核对产物', render_page: '渲染页面',
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
