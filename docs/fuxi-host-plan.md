# 内置 Fuxi Agent：宿主协议与集成契约

本文档定义 Flying draws 桌面主进程与内置无界面执行内核（`fuxi --host`）之间的进程边界、NDJSON 双向通信协议与画布状态协同契约。

## 分工和范围

- Fuxi 仓库：复用 `fuxi-qian::Agent`，新增 `fuxi --host`，提取与桌面共用的无界面初始化，修复 MCP 图片传递，添加协议契约测试。原 CLI/TUI/ACP 保持兼容。
- Flying draws：监管内置进程、独立配置/会话、任务记录、画布选区与图片输入、模型设置、计划/执行/审批/停止/继续的面板、构建和分发入口。
- 不调用真实模型验证，不启动 GPU 模型。验证用隔离目录、本机回环假供应商与已有测试；不覆盖用户画板、真实 Fuxi 配置和已安装程序。
- 首版不做多 Agent 调度、后台自动续跑、学习配置或工作流编辑器。后台 jobs 沿 Fuxi 原行为，可能在选定工作区写 `.rivet/jobs`；配置和会话独立隔离。

## 进程和协议

启动：`fuxi --host --host-data <FLYINGDRAWS_HOME>/agent --config <FLYINGDRAWS_HOME>/agent/config.toml`。stdout 只输出 NDJSON 帧，诊断走 stderr。配置不存在时宿主生成自己的最小配置，不合并原 Fuxi 全局配置。

请求：`{ jsonrpc: '2.0', id: number, method: string, params: object }`。宿主与 MCP 图片帧必须支持至少 5 MiB 原图的 Base64；默认 ACP 的帧上限保持兼容。

响应：`{ id, result }` 或 `{ id, error: { code: string, message: string } }`。

事件：`{ type: 'event', seq, run_id: string|null, req: number|null, schema_version, event, data }`。`event/data` 复用 Fuxi `event_json`。启动失败可发 `{type:'fatal',message}` 后退出。`schema_version` 是保留字段：客户端不校验它，协议版本只认 `initialize` 返回的 `protocol`。

| 方法 | params / result |
| --- | --- |
| `initialize` | `{protocol:1,client:{name,version}}` → `{protocol:1,fuxi_version,schema_version,capabilities:{images:true,plan:true,resume:true}}` |
| `workspace.open` | `{cwd,session_id?,new_session?,mcp_servers?,approval_mode?}` → `{session_id,provider,model,choices,setup_needed,vision,approval_mode,history_len,tools}`；`approval_mode` 为 `'auto-safe'\|'full-access'`，客户端开会话时带上当前选择，内核据此决定哪些工具调用需要逐次审批。MCP map 与 `McpServerConfig` 同形，只在当前宿主运行中生效。`tools` 为 `[{name,label}]`，只列内核里编号命名的工具（MCP 为 `server/原名`），供界面显示可读名称。MCP 工具声明 `annotations.readOnlyHint: true` 时，规划等只读模式也可调用，但仍需逐次审批；画布桥接的 `canvas_read`、`canvas_list` 带此标记 |
| `provider.add` | 原 `ProviderRegistration` 字段，协议用配置名字符串 → accepted，实际结果 `provider_setup` 事件 |
| `provider.switch` | `{provider,model?}` → accepted，实际结果 `provider_switched` / `provider_switch_failed` |
| `session.set_approval_mode` | `{mode:'auto-safe'\|'full-access'}` → `{mode}`；内核已连上时当场生效，进行中的任务从下一个工具调用起生效，结果另回 `approval_mode_changed` 事件 |
| 会话切换 | 客户端不调用 `session.list/open/new`；切会话统一走 `workspace.open`：带 `session_id` 续用已有会话，带 `new_session:true` 新建 |
| `run.start` | `{run_id,mode:'direct'\|'plan',text,images:[{media_type,data}]}` → 立即 `{accepted:true}` |
| `run.execute_plan` | `{run_id,text}` → 立即 accepted；执行控制器持有的原计划，text 仅作用户补充 |
| `run.resume` | `{run_id,task_id,text,images?}` → 立即 accepted；只恢复未完成 task |
| `run.cancel` | `{run_id}` → `{cancelled:true}` |
| `approval.respond` | `{request_id,decision:'approve'\|'reject',reason?}` → `{delivered:true}`，必须按 request_id scoped |
| `shutdown` | 取消活动任务、尽力落盘并退出 |

单 Agent 忙时拒绝其它任务和配置请求，`run.cancel` / `approval.respond` 走旁路。所有 MCP 工具首版沿原审批，不根据可伪造文字自动放行。首轮图片直接附加，不依赖先调 MCP。

每次执行结束，在原 `task_finished` / `plan_prepared` 等事件之后，宿主发送 `run_finished`（`data:{task_id?,outcome?,error?}`），最后发送 `done`。错误不得带凭据。`run_finished` 不能拿上一轮结果充数。命令本身的错误与 outcome 独立发送，Completed 不遮掉后续规划校验错误；可重试的暂态 error 事件让位于最终成功 outcome。

## 任务与画布

一个画布工作项绑定 board、cwd 和一个 session。每次规划/执行/返工有独立 run_id，保留实际内核 task_id。Completed 后的新要求在同一会话开启新 task；未完成任务只有用户显式选择「继续原任务」才 resume，另可选择「同会话新目标」重计预算，失败默认后者。重启只恢复记录，活动记录标为 interrupted，由用户明确继续。

画板改名迁移工作项并作废计划，删除画板归档工作项；重建同名画板不复用历史会话。历史工作目录丢失时保留记录，回退到应用工作区并新建会话，界面显示提示。结果图片以哈希命名、原子写入，放回画布时保留作者筛选和删除标记。

输入不声明画板版本——结构摘要里的版本号恒为 v0，不绑定真实画板版本，只绑定选中元素的稳定 ID、结构摘要和 PNG；agent 需要版本时用 `canvas_read` 取当前 `base_version`。无选区时使用当前画板。模型不支持视觉时明确显示只发送结构。隐藏作者筛选不改变真实上下文。原画布 MCP 保留，内置 Agent 通过同一通路读写和提议。

## 可检查交付

1. 没有原 Fuxi/Claude/Codex 安装也能使用随应用构建和分发的内核；首次能在应用内保存自己的模型设置。
2. 画布选区和截图通过宿主进入假供应商请求；文字、工具、审批、计划和真实终态能呈现。
3. 可接受或拒绝工具、取消运行、确认计划执行、在同会话继续；应用重开不自动执行。
4. MCP text+image 以真正图片进入模型上下文；原画板、原 Fuxi 配置和已安装程序保持完好。
5. Electron 类型检查/构建、针对性客户端与持久化测试，以及 Fuxi 宿主和多模态契约测试通过。完整模型效果另需用户明确预算。
