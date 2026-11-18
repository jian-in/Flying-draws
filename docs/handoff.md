# 接手文档

## 最新：多轮视觉演进墙、零门槛 CLI/免编译打包与架构白皮书（2026-11-18）

围绕「对外 30 秒零门槛接入吸 Star」与「底层五大工程设计沉淀」完成三项升级（深度架构解析见 [architecture.md](architecture.md)，演示录制步骤见 [demo-playbook.md](demo-playbook.md)）：

- **多轮视觉演进墙（`src/main/lineage.ts` + `agent.ts` + `App.tsx` + `AgentPanel.tsx`）**：
  - `AgentRun` 与 `ImageSourceMeta` 记录演进血缘（`sourceImageRef`）与本轮修改过的短文件名摘要（`changedFiles`，从已完成的 `write_file` / `edit_file` / `apply_patch` 提取最多 4 项）。
  - `shouldAutoPlaceResultImage()` 严格剔除 `canvas_read` / `canvas_list`（含 `mcp_*canvas_read*`）返回的画布自身截图，杜绝画中画自动插入死循环；仅 `render_page`、`browser_page` 等页面/产物截图参与自动上墙。
  - `planImageLineage()` 按 `customData.flyingdraws.result === image.id` 幂等去重，自动定位父图（`sourceImageRef` 优先，其次同 `workItemId` 下最近上一轮图片）并在右侧 `parent.x + parent.w + 160` 排布，同步生成带改动文件标签的绑定箭头与顶部题注（如 `v2 · 1280×720`，均带 `author: 'agent', agent: AGENT_SEAT, seat: true, layer: 'final'` 兼容作者筛选）。`AgentPanel` 提供默认开启的「自动把页面结果图连入画布演进链」开关，手动「放到画布 ↗」同样走演进链排版。
- **零门槛 CLI、多路径寻址与纯画布打包（`src/bridge/index.ts` + `package.json` + `scripts/package-desktop.mjs` + `.github/workflows/release.yml`）**：
  - `out/bridge/index.js`（同时导出 `flying-draws` 与 `flying-draws-mcp` bin）在无参数或 `--mcp` 时 100% 保持纯净 `stdio` MCP 模式；传入 `setup [claude|cursor|codex|antigravity]`（或 `config`）、`doctor`、`--help`、`--version` 时执行轻量 CLI 配置向导与环境自检。
  - `launchApp()` 按 `FLYINGDRAWS_APP` → 独立包同级 `Flying draws.exe` → 仓库 `dist/Flying-draws-win32-x64/Flying draws.exe` / `%LOCALAPPDATA%\Flying draws\Flying draws.exe` → 开发环境 `require('electron')` 依次寻址。
  - 新增 `npm run package:canvas`（`node scripts/package-desktop.mjs --without-fuxi`），无私有 Fuxi 源码也能打出纯 MCP 外部画布桌面包；新增 `.github/workflows/release.yml` 自动跑 CI 并在 `v*` tag 构建 Windows Release 包。
- **门面重写、架构白皮书与示例资产**：
  - 重写根目录 `README.md`：明确「给编码 Agent 用的本地视觉演进画板与双向提议草稿纸」定位，首屏前置三大核心场景与 30 秒零门槛接入，内置 Fuxi 工作台收归进阶章节。
  - 新增 [docs/architecture.md](architecture.md)（拆解双向提议 Diff、乐观并发指纹与 Rebase、两阶段手写分组与像素逆映射、Win32 DWM 伴随吸附、双通道隔离安全五大设计）、[docs/demo-playbook.md](demo-playbook.md)（两支 15s GIF 分镜录制手册）与标准示例画板 `examples/architecture-sketch.excalidraw`。

## 内置 Fuxi Agent（2026-11-17）

产品已转向以画布为主界面的独立 Agent；原 MCP 画布功能保留。实现契约与分工见 [fuxi-host-plan.md](fuxi-host-plan.md)。下方旧里程碑描述原 MCP 阶段，不再代表全部现状。

- `src/main/agentClient.ts`：无界面 Fuxi 子进程、NDJSON 请求/事件、按 req 等待命令完成、退出时拒绝在途请求。
- `src/main/agent.ts`：配置/会话连接、画布上下文、工作项与 run 映射、终态、历史记录与图片 blob。重启不自动执行；损坏历史备份后继续记录，未知版本或超限记录保留原文并阻止新执行。
- `src/main/agentIpc.ts`、preload 的 `agent`：只暴露业务方法，包含原生目录选择；不暴露任意 shell 或文件读取。
- `src/renderer/src/AgentPanel.tsx`：模型设置、目录、任务历史、计划确认、工具审批、停止、图片预览与放回画布。`App.tsx` 提供选区截图和图像插入。
- Rust 源码在 `/path/to/fuxi-code`，`fuxi --host --host-data DIR --config DIR/config.toml`；宿主与原 desktop 共用 `workspace_boot`。CLI/TUI/ACP 保持原入口。
- `npm run build:fuxi -- --debug` 构建并复制内核到被 git 忽略的 `resources/fuxi/`；可用 `--source` 或 `FLYINGDRAWS_FUXI_SOURCE` 指定另一处源码。默认离线构建，`--online` 才允许获取 Cargo 依赖。
- `npm run package:desktop` 使用现有 Electron 与运行时依赖生成 Windows 独立目录包；不能覆盖已存在的输出。
- `npm run e2e:agent` 使用真实应用、内核、MCP 和本机 SSE 假供应商，所有文件在隔离目录，结束后清理；截图和摘要在 `out/e2e/agent*`。测试实例关闭后台节流，并用 Electron 原生 capturePage 捕获隐藏窗口。

任务与画板的边界已处理：未完成任务可显式选择「继续原任务」或「同会话新目标」，失败默认新目标；目录丢失会回退到应用工作区并新建会话、保留旧记录和提示；改名迁移任务并作废待执行计划；删除画板归档任务，同名新画板不会继承旧会话。执行与画板变更互斥，运行中切画板后会重新连接当前画板。结果图片插入保留作者筛选和删除标记。

交付与验证（2026-11-17）：

- 独立目录包：`dist/Flying-draws-win32-x64/Flying draws.exe`，需保留同目录全部文件。随包内核为 debug 构建，来源和 SHA-256 记录在 `resources/fuxi/manifest.json`；原安装程序未替换。
- Electron 类型检查、构建通过；107 个单元测试通过，最终持久化调整后的 10 个针对性测试通过。
- 实际独立包端到端验证通过：首次模型设置、选区截图、MCP 审批与图片回传、计划执行、取消/显式续接、画板改名保护、缺失目录恢复、相对 HOME、作者筛选和删除标记。报告 `out/e2e/agent-report.json`，浅色/深色截图 `out/e2e/agent.png`、`agent-dark.png`。使用本机假供应商，没有调用真实模型。
- Claude 完成 Rust 宿主、图片协议和规划失败终态修复，并运行宿主契约测试及相关检查；多智能体并行审查后，9 项 P2 均已修复并由其再次只读核实闭合，复核路径内没有剩余 P1/P2。
- 两个仓库的改动尚未提交。早期缺依赖的目录包保留在 `dist/Flying-draws-win32-x64-incomplete`，不用于交付。

后续改动（2026-11-17 晚，Claude）：

- **思考折叠**：内核的 `thinking_delta` 存进 run 的 `thinkingDraft`（流式预览，落盘时清空），最终消息的思考块存进 `thinking`（上限 6 万字，超出保留最新部分；被停止的轮次保留已流出的部分）。面板在回复上方显示「思考中…」/「思考过程」，默认收起。
- **计划只显示一次**：规划轮的回复放在「待确认的计划」框里，不再另显示一遍；内核计划摘要里重复的请求和画布上下文不展示。
- **工具名**：`workspace.open` 返回 `tools:[{name,label}]`（MCP 为 `server/原名`），`shared/agent.ts` 的 `toolDisplayName()` 翻成中文，用于工具记录和审批卡。
- **规划时可读画布**：Fuxi 认 MCP 工具的 `annotations.readOnlyHint`，只读模式下可调用但仍要逐次审批；桥接的 `canvas_read`、`canvas_list` 带此标记。
- **席位名统一**：`AGENT_SEAT = 'Fuxi'`，提示词、桥接环境变量 `FLYINGDRAWS_SEAT`、插回画布的图片作者都用它；画布在线标记不再同时出现 `fuxi` 和 `Fuxi`。
- **后台常驻**：关窗口（× / Alt+F4）只隐藏窗口，页面不降频，画布读写和 Agent 任务照常进行；托盘图标（`src/main/trayIcon.ts` 按像素画出，不需要图标文件）单击打开，右键菜单可退出，或勾选「开机时在后台启动」（只在打包应用、默认数据目录下可用，启动参数 `--background`）。真正退出走托盘「退出」或系统注销/关机。隔离测试实例（`FLYINGDRAWS_HOME` + `FLYINGDRAWS_DEBUG_PORT`）不建托盘，关窗口仍直接退出。
- 验证：单元测试 111 个通过、类型检查通过；Fuxi 侧 MCP、宿主契约、全工作区 Clippy、fmt 通过；隔离实例实测关窗口后隐藏、隐藏时规划任务读画布成功、在线标记只剩 `Fuxi`、`app.quit` 后所有进程 1 秒内退出；`npm run e2e:agent` 对新包通过。之前的包改名保留为 `dist/Flying-draws-win32-x64-prev-20261117`（Codex 交付版）和 `-prev2-thinking`（中间版）。

当前限制：单 Agent、单个活动工作区；工具图片每个 MCP 结果只保留首张；宿主不改原 Fuxi 全局配置，但作业和产物仍可能写所选工作区的 `.rivet`。计划是进程内状态，重连/切会话后须重新拟定。没有真实模型质量结论，真实模型调用前需明确设置费用上限。

> 新会话动手前先读这份，再按需看 [design.md](design.md)。
> 最后更新：2026-11-16，手感优化（发送快捷键、画板工具挪进标题栏、agent 新内容找空位落笔、连线绕开障碍）之后。

## 一句话

Flying draws：本地桌面画布（Electron + Excalidraw），通过 MCP 接任意 agent。用户用画表达想法，agent 读到的是结构化的文字描述，认不出来的内容附截图。

## 现在在哪

| 里程碑 | 状态 | 提交 |
|---|---|---|
| M0 技术验证 | ✅ | `94a9fe9` |
| M1「画给 agent 看」 | ✅ 代码完成，单元测试和端到端测试通过；用户已在真实画布上手写字、经 MCP 读到并靠截图认出 | `6ee92fc` |
| M2-a 写入通路 | ✅ `canvas_draw` 纯新增（节点、连线、文字），单元测试和隔离画板上的端到端测试通过；已在真实 Antigravity 会话中演示手写识别 | 见 git log |
| M2-b 自动排版 | ✅ 新节点用 dagre 排版，可选从左到右或从上到下；箭头按图形轮廓起止，跨层连线会绕开节点 | 见 git log |
| M2-c 提议层 | ✅ `canvas_propose`：agent 画的提议是蓝色虚线半透明，用户点接受或拒绝，结果经 `canvas_wait` 回到 agent；已在真实 Antigravity 会话中走通接受流程 | 见 git log |
| M2-d diff 和并发 | ✅ 用户改了提议的 diff、待处理请求重启后恢复、按元素判断冲突、agent 改字和删除自己画的东西 | 见 git log |
| 多画板新建与切换（M4 提前引入） | ✅ 页面右上角支持切换画板和「+ 新建画板」，MCP 新增 `canvas_list`、`canvas_open(board?, title?)` 及各读写工具可选 `board` 参数 | `2f341c6` |
| 画板重命名/删除与收件箱持久化 | ✅ 页面支持「重命名」「删除」（至少保留一块，非切换操作走 `syncBoards` 保留撤销栈）；MCP 新增 `canvas_rename`、`canvas_delete`；未取走的「发给 agent」收件箱随 `pending.json` 持久化并在重启后恢复 | `2f341c6` |
| agent 干预用户内容、改样式与作者筛选 | ✅ 独立文字（`T1`）和手绘（`S1`）纳入编号与改删；新增 `update_text` / `delete_text` / `delete_strokes` / `set_style`；`canvas_draw` 与 `canvas_propose` 均可改删任意已确认元素（提议中以虚线标记框预览，支持单处删除拒绝）；记录 `agent` 署名并在页面底部提供作者筛选标签 | 见 git log |
| 多席位联手作画与「递画笔」接力 | ✅ 工具支持 `as` 声明席位并自动分配 6 色固定色板；底部筛选栏按实际席位动态生成带色点标签；新增 `canvas_pass` 工具，支持与 `canvas_wait` / `canvas_read` 席位间直接或挂起交接画笔 | 见 git log |
| 手感优化 | ✅ `Ctrl+Shift+Enter` 打开「发给 agent」、再按一次发出，横幅里 Enter 发送、Esc 取消；画板切换、新建、「⋯」菜单和保存状态挪进标题栏，画布右上角只留「发给 agent」；agent 的新内容紧挨着它连接的节点或落在用户视野里的空位（`placeBlock()`），直线会压到东西时加拐点绕开（`detourPoint()`）；新内容已在眼前时不再移动视野 | 见 git log |
| 点选席位发送与剪贴板兜底（「叫醒 agent」第 1 步） | ✅ 两个以上席位在线时，「发给 agent」横幅可点选「所有 agent / @某席位」；点选了席位的画只有那个席位能取（`canvas_read` / `canvas_wait`）。对方正在等就直接送达，否则进收件箱，并把一句带画板、版本、席位的取画指令放进剪贴板 | 见 git log |

- 远程：GitHub 仓库 `jian-in/Flying-draws`，本地 `master` 跟踪 `origin/master`。
- 项目名是 **Flying draws**，内部标识符统一用这个名字：数据目录 `~/.flyingdraws`、页面接口 `window.flyingdraws`、元素标记 `customData.flyingdraws`、画板元数据 `scene.flyingdraws`、环境变量 `FLYINGDRAWS_HOME` / `FLYINGDRAWS_DEBUG_PORT`、npm 包名和 MCP 服务名 `flying-draws`、样式前缀 `fd-` / `--fd-`。发布前仍要查 GitHub / npm 重名。

## 怎么跑

```bash
npm install          # 会顺带下载 Electron（postinstall）并拷贝字体
npm run build        # 应用打包到 out/，桥接编译到 out/bridge/
npm run build:bridge # 仅编译 MCP 桥接与 CLI（out/bridge/index.js）
npm run dev          # 开发模式启动画布
npm test             # 单元测试（node --test "test/*.test.ts"）
npm run typecheck
npm run inspect      # 打印画板结构（可跟路径，如 node scripts/inspect.mjs examples/architecture-sketch.excalidraw）
npm run package:canvas   # 免 Fuxi 内核打包纯 MCP 画布 Windows 独立目录包
npm run package:desktop  # 打包带内置 Fuxi 内核的完整 Windows 独立目录包
node out/bridge/index.js setup    # 输出 Claude Code / Cursor / Codex / Antigravity 接入配置
node out/bridge/index.js doctor   # 环境、构建产物与桌面端寻址自检
```

端到端测试（扮演 agent 调 MCP，用 CDP 扮演用户点按钮）：

```bash
npx electron . --remote-debugging-port=9333   # 先关掉已开的画布，另开终端保持运行
npm run e2e                                    # 截图输出到 out/e2e/
```

`canvas_draw` 的端到端测试不用先开应用，也不碰用户的画板：

```bash
npm run e2e:draw     # 自己拉起一个隔离实例，画板在 out/e2e-home，截图在 out/e2e/draw.png
```

它还会用 DevTools 端口 9334 在页面里点按钮，扮演用户接受和拒绝提议（隔离实例上设了 `FLYINGDRAWS_DEBUG_PORT` 才会开这个端口）。提议的截图在 `out/e2e/propose.png` 和 `propose-accepted.png`。

隔离靠环境变量 `FLYINGDRAWS_HOME`：设了它，画板、`daemon.json` 和 Electron 的 userData 都放到那个目录下，可以和用户开着的画布同时运行。**凡是会往画布上写东西的测试都要用它。**

## 代码地图

```
src/main/index.ts      主进程入口：窗口、多画板会话切换/重命名/删除/版本号（含 N/T/S/I 编号对照）、给页面的 RPC、本地服务的路由
src/main/boards.ts     画板标识校验、文件名映射、标题归一化/更新、回退画板选择、空画板模板与元数据解析（纯函数）
src/main/geometry.ts   纯几何工具：图形轮廓出线点 exitPoint()（主进程排版与页面改节点形状/尺寸共用）
src/main/semantic.ts   语义层（纯函数）：buildGraph() 出结构（含 N/T/S/I 编号、标注圈预判与原图像素逆映射），summarize() 出中文描述
src/main/imageSize.ts  零依赖二进制图像头像素尺寸解析（PNG / GIF / WebP / JPEG / SVG）
src/main/ops.ts        绘图指令 → 绘图计划（纯函数）：校验 ops、编号换算、trace_image 照图还原、toProposalPlan() 预览标记框转换
src/main/diff.ts       提议的底稿和改动对比（纯函数）：用户在提议上改了什么（跳过 role: 'marker' 标记框）
src/main/lineage.ts    多轮视觉演进墙排版（纯函数）：防 canvas_read 递归过滤、幂等防重、横向 v1→v2→v3 落位与改动文件连线规划
src/main/dock.ts       Win32 窗口伴随吸附（koffi FFI + DWM 跨 DPI 边框校准 + SetWinEventHook）；几何计算在 dockGeometry.ts
src/main/daemon.ts     本地 HTTP 服务：127.0.0.1 随机端口 + token + Origin/Host 防重绑定，信息写 ~/.flyingdraws/daemon.json
src/main/requests.ts   请求队列：agent 请求作画、提议（含 pending 改动）、用户发送/取消、长轮询等待、收件箱与席位递画笔交接
src/main/seats.ts      在线席位登记表 SeatRegistry（纯逻辑）：跟踪桥接或调用方、分配 6 色色板、离场或超时后清理
src/preload/index.ts   页面能调用的全部接口（含画板管理、请求与内置 Agent 业务接口）
src/renderer/src/App.tsx  画布、标题栏画板工具、底部动态席位/作者筛选、请求横幅、图像插入与演进连线落地、主进程 RPC 响应
src/renderer/src/AgentPanel.tsx  内置 Agent 面板：模型设置、任务历史、审批、自动演进链开关与手动放到画布
src/bridge/index.ts    MCP 桥接（stdio 10 个工具）+ 零门槛 CLI（setup / doctor / --version / --help）+ 多路径桌面端自动寻址拉起
examples/architecture-sketch.excalidraw  开箱体验用的标准 Excalidraw 示例画板
docs/architecture.md   五大核心工程设计白皮书；docs/demo-playbook.md 为 15s GIF 分镜录制手册
test/                  单元测试（boards / cli / daemon / diff / dock / imageSize / lineage / ops / pending / requests / seats / semantic / traceImage 等）
scripts/e2e-draw.mjs   M2 + 多画板完整端到端测试；scripts/e2e-agent.mjs 为内置 Agent 端到端测试
```

读的数据流：agent → 桥接（stdio MCP）→ 本地服务（HTTP）→ 主进程 →（RPC）→ 页面取快照 → 主进程算语义 → 原路返回。

写的数据流（`canvas_draw`）：主进程先取快照定版本号 → `planOps()` 出绘图计划 → 页面的 `applyPlan()` 用 Excalidraw 的 `convertToExcalidrawElements` 生成元素、打上作者标记、绑定箭头，再 `updateScene` → 主进程存盘升版本号。所有写入在主进程里排队，一次一批。

提议的数据流（`canvas_propose`）：和 `canvas_draw` 走同一个 `drawOps()`，若含改删指令则由 `toProposalPlan()` 转成围绕目标元素的虚线标记框（删除用 `#e03131` 红色、其余改动用蓝色，框上方附一行中文说明，`role: 'marker'`）并把实际改动放进 `pending` 随 `pending.json` 存盘；新增元素打上 `layer: 'proposal'`。用户点「对，就这样」时，`resolveProposal()` 检查哪些标记框还留在画布上，仅执行未被删掉的改动（被删掉的标记框作为 `不同意...` 写进 `changes`），同时把正式元素固化并清理全部标记框。

用户改了什么（`src/main/diff.ts`，纯函数）：提议画上去时 `captureBaseline()` 记一份底稿，存在请求上；用户接受时 `diffProposal()` 拿当时的画布和底稿比，输出几句中文（改了文字、挪了位置、删了什么、自己加了什么），放在 `canvas_wait` 结果的 `changes` 里。挪动不到 24px、大小变化不到 25% 的不报。

待处理的请求和未取走的收件箱会存盘：每次请求或收件箱有增减就原子写 `~/.flyingdraws/pending.json`（v2 格式 `{ version: 2, boards: { [boardId]: waiting[] }, inbox?: { [boardId]: Submission[] } }`，兼容旧版 `{ board, requests }`），应用启动时按画板读回来——等待中请求的编号不变（`request_id` 重启后还能用、确认横幅会重新出现），用户之前"发给 agent"但尚未被取走的收件箱内容与等待条也会一并恢复，直到被 `canvas_read` 或不带 `request_id` 的 `canvas_wait` 取走后清空。提议对应的元素要是已经不在对应画板上了（比如用户手动删光了），这个提议就不恢复。

多画板状态管理（`src/main/boards.ts` + `src/main/index.ts`）：
- 每块画板对应 `~/.flyingdraws/boards/<id>.excalidraw`，标题（可选）保存在 `scene.flyingdraws.title`。当前激活的画板 ID 记在 `~/.flyingdraws/state.json`，重启后自动恢复；没有 `state.json` 时默认 `default`。
- 每个画板在主进程有独立的 `BoardSession`（`version`、`history`、`RequestHub`），`requestBoard` 映射记录 `request_id → boardId`，切画板不会把别的画板的待处理横幅串过来。
- 窗口标题栏里提供画板下拉框切换、「+ 新建画板」和「⋯」菜单（「重命名」「删除」等）（仅剩最后一块画板时禁用删除）；切换或删除当前画板前会自动把当前场景落盘，页面通过 `resetScene()` + `addFiles()` + `updateScene()` + `history.clear()` 载入目标画板，避免跨画板撤销串台。
- 重命名会迁移 `.excalidraw` 文件、更新 `scene.flyingdraws.title`、迁移内存 `BoardSession` 与 `requestBoard` 映射，并通过 `syncBoards` RPC 同步页面标题/列表而不重置画布和撤销栈；删除会取消并清空该画板的请求和收件箱、删除磁盘文件，若删的是当前激活画板则优先回退到 `default`（否则选剩余第一块）。

多个请求同时等着时按先来后到一个一个问，横幅上写着后面还有几个；轮到一个提议时视野会移到它上面，并让开顶部的横幅。

冲突怎么判断（design.md 12.3）：主进程每给 agent 一份画板描述，就在对应画板的内存记录里记下那个版本的"编号 → 元素"对照表和每个元素的指纹（`history`）。agent 带着 `base_version` 来画时：
- 版本没变：直接执行。
- 版本变了：`rebaseOps()` 把指令里的旧编号换算成同一个元素现在的编号。引用的节点被删了 → 冲突；要改动或删除的元素指纹变了（被别人动过）→ 冲突；只是连线过去、旁边加字 → 照常执行。
- 查不到那个版本，或者没带 `base_version` 却引用了已有节点 → 冲突，让 agent 重新读。

界面样式（`styles.css`）：淡黄纸面 + 墨线描边的线稿风（1.5px 墨线、错开的实线代替柔和阴影、黄色主按钮），同一段里也覆盖了 Excalidraw 工具栏的颜色变量。画布默认背景是纸色 `#fffbe6`（`App.tsx` 的 `PAPER_COLOR`）：载入时只把仍是默认白底的画板换成纸色，用户自己选过背景色的不动。窗口没有系统标题栏和菜单栏（`titleBarStyle: 'hidden'` + `titleBarOverlay`）：顶上 36px 那条是页面自己画的 `.fd-titlebar`，和画布同色、可拖动窗口，右边留给系统的最小化/关闭按钮；按钮颜色由页面经 `window:theme` 通知主进程跟着深浅色换。高度和颜色在 `index.ts` 的 `TITLEBAR_*` 和 `styles.css` 的 `--fd-titlebar-h`、`--fd-paper` 两处，要一起改。自己的界面统一用 `--fd-*` 颜色变量，页面把 Excalidraw 当前的深浅色写到 `<html data-fd-theme>` 上，横幅、弹窗、菜单跟着切换。「⋯」菜单用 portal 挂在 body 上，免得被横幅盖住。端到端测试会输出界面截图 `out/e2e/ui-menu.png`（浅色）和 `ui-dark.png`（深色）。

外观约定：不同席位按顺序分配固定高对比色板（`#1971c2` / `#7048e8` / `#0c8599` / `#d9480f` / `#2f9e44` / `#c2255c`，默认单席为蓝色 `#1971c2`）；还没确认的提议再加虚线和 55% 透明度；接受后变实线、不透明，仍是对应席位颜色（提议里的改动预览标记框透明度 75%、虚线，删除用 `#e03131` 红色，接受或拒绝后均清理）。用户在提议上改过的地方（拖动、改字、删掉一部分或删掉某个改动标记框）接受时按用户的调整生效并反馈给 agent。

作者标记写在元素的 `customData.flyingdraws = { author: 'agent', agent?: '席位或客户端名', seat?: true, color?: '#xxxxxx', layer: 'final' }`（提议是 `layer: 'proposal'`，另带 `proposal: 提议编号`，标记框另带 `role: 'marker'`）。已在 Excalidraw 0.18.1 里确认：`customData` 是所有元素都有的可选字段，新建、载入、导出时都原样保留。没有这个标记的元素都算用户画的。画布底部筛选栏在单 agent 时显示「全部 / 我画的 / agent 画的 / 其他 agent」，出现具名席位或多名 agent 时自动转为带席位颜色圆点的动态席位标签，只临时切换界面显示（隐藏的元素 `opacity: 0`、锁定、不改 `version`），读写快照与落盘始终保留完整画布。

## MCP 工具

| 工具 | 说明 |
|---|---|
| `canvas_open` | 打开并前置窗口；可选 `board` 和 `title`，`board` 不存在时自动创建空白画板并切换过去 |
| `canvas_list` | 列出 `~/.flyingdraws/boards/` 下的所有画板（含当前激活标记、标题、版本号、元素数） |
| `canvas_rename` | 重命名指定（或当前）画板，并可选设置/清空显示标题（`title: null` 清空），保留当前会话和撤销历史 |
| `canvas_delete` | 删除指定（或当前）画板及其 `.excalidraw` 文件（不能删最后一块）；若删除当前画板会自动切换到剩余画板 |
| `canvas_read` | 可选 `board`、`as`；`format: summary/graph`，`image: auto/always/never`；输出节点（`N*`）、独立文字（`T*`）、手绘（`S*`），并按调用席位区分本 agent 与其他 agent，顺带取走收件箱里发给自己或没指定席位的画，以及递画笔交接；auto 只在有涂鸦、图片、线条时附图 |
| `canvas_request` | 可选 `board`、`as`；弹出请求横幅，立即返回 `request_id` |
| `canvas_wait` | 最多等 45 秒，可选 `as`；带 `request_id` 等那个请求（自动路由到对应画板），不带就等当前或指定 `board` 上用户主动"发给 agent"或别的席位递过来的画笔（`handoff`） |
| `canvas_pass` | 递画笔给另一个席位（可选 `to` 和 `board`/`as`，必填 `note`）；若目标席位正在 `canvas_wait` 则立即唤醒，否则挂在画板上等对方调用 `canvas_wait` 或 `canvas_read` 时接走 |
| `canvas_propose` | 可选 `board`、`as`；参数同 `canvas_draw`（含新增与改删/改样式），另加 `question`。新增画在提议层，改动以标记框预览，用户可删掉单个标记框拒绝对应改动；立即返回 `request_id`，用 `canvas_wait` 等结果 |
| `canvas_draw` | 可选 `board`、`as`；`ops` 支持新增（`add_node` / `add_edge` / `add_text`）及改删/改样式（`update_node` / `delete_node` / `update_edge` / `delete_edge` / `update_text` / `delete_text` / `delete_strokes` / `set_style`），可用在画布上任意已确认元素上（未确认提议除外），整批生效或整批不生效。`direction: right/down` 定排版方向。引用已有元素（`N1`/`T1`/`S1`）时必须带 `base_version`；冲突时返回原因和当前画板 |

工具描述是英文（给各种 agent 用），返回的画板描述是中文。国际化还没做。

## 开发与本地调试提示

- MCP 服务 `flying-draws` 已用 `claude mcp add` 注册在 **/path/to/flying-draws 项目的 local scope**，命令 `node /path/to/flying-draws/out/bridge/index.js`。只有在这个文件夹里新开的会话才有这几个工具，工具全名是 `mcp__flying-draws__canvas_*`。
- 用户的画板 `~/.flyingdraws/boards/default.excalidraw` 里有**用户自己画的东西**（手写字、涂鸦），测试时只读，不要清空或覆盖。
- npm 用的是 npmmirror 镜像，Electron 也从镜像下载。

## 踩过的坑

1. **npm 11 默认不执行依赖包的安装脚本**，Electron 本体不会下载。已在 `package.json` 的 `postinstall` 里手动调用 `node_modules/electron/install.js`。
2. **桥接发 GET 请求时不能带 `content-length`**：Node 默认复用连接，服务端会把下一个请求的开头当成这次的请求体，结果是 HTTP 400 空响应，表现为桥接报 "Unexpected end of JSON input"。
3. Excalidraw 0.18 默认从 CDN 加载字体。我们用 `scripts/copy-fonts.mjs` 拷到本地，并在 `main.tsx` 里设置 `window.EXCALIDRAW_ASSET_PATH`。
4. 被 `Stop-Process` 强杀的应用不会清理 `daemon.json`，留下旧端口。桥接会先做健康检查，失败就重新拉起应用，所以不影响使用。
5. 改了语义层的输出格式时，要同时检查 `index.ts` 里 `describe()` 追加的提示语。"已附截图"这句话要和实际是否附图一致。

## 已知不足和下一步

**手绘笔画分组（已做）**
- 挨得近的笔画并成一组，摘要里写成"一组手写或涂鸦（N 笔），在某节点右上方，内容请看附图"，有分组时自动附图。结构在 `graph.strokeGroups`，`graph.strokes` 只剩没被分组的单笔。
- 判断"挨得近"用的是两笔采样点之间的最短距离，阈值取较小那笔的对角线长度（夹在 30 到 150 之间），见 `semantic.ts` 的 `GROUP_GAP_*`。阈值只按用户现有画板校准过一次，换一种字迹可能要调。
- **已做**：一个圈圈住一组手写时，预判标注圈不参与并查集吞并，摘要输出「圈住了 S1（一组手写，N 笔）」；反向（往左/往上）起笔的手绘圈按实际 `points` 算外接框；图上的圈选/框选/箭头指向会自动换算成原图像素坐标。还没做：多笔画成的箭头仍会被当成一组涂鸦。

**排版现在怎么做的（M2-b）**
- 一批指令里没指定坐标的新节点交给 dagre（`@dagrejs/dagre` 3.1.3）排成一块，`direction` 是 `right`（默认）或 `down`。**已有元素一律不动。**
- 整块放哪儿由 `ops.ts` 的 `placeBlock()` 决定：
  - 连着已有节点：紧挨着那些节点放。横排先试右边、竖排先试下面，被占了换另一侧，两侧都被占就从正下方往下找第一处空位。
  - 不连已有节点：放进用户当前视野里第一处放得下的空位（页面的 `snapshot` 会带回 `view`，已让出工具栏、横幅和底部筛选栏）；视野里放不下就放在视野这一竖条内容的下面。拿不到视野时退回老办法：所有内容的最下方。
- 没有 dagre 拐点的连线，如果两端中心的直线会压到别的元素，`detourPoint()` 在中点的垂直方向上加一个拐点绕开；绕不开就照旧画直线。端点落在里面的框（节点自己、圈着它的大框）不算障碍。
- 画完后，新内容已经全在用户眼前（且没被横幅挡住）时视野不动，否则才移过去。
- 挂在新节点旁边的文字（`add_text` 带 `near`）会在排版时留出位置，不会压到别的节点。
- 相邻两层之间的连线画直线，跨层的连线用 dagre 给的拐点画成曲线。箭头起止点按矩形、椭圆、菱形各自的轮廓算。
- 节点编号（N1、N2……）按阅读顺序排，排版一变编号就可能变。测试和 agent 都要用 `canvas_draw` 返回的对照表（`open = N1`），不要假设顺序。

**M2-a、M2-b 留下的缺口**
- 连线绕行优先加一个中垂线拐点，密集多障碍挡死单拐点时退回 `detourPath()` 双拐点平行走廊绕行；仍绕不开才退回直线。连线上的文字、连线本身不算障碍。
- 找空位只看元素的外接框：用户画的一个大圈、一条长斜线会把它框住的整块区域都算成被占。
- 没有"移动"指令。改字后（`update_node` / `update_edge`）不会对整块重新排版：连线上的字太长时可能盖住箭头，节点只会长高不会变宽（但 `set_style` 支持直接指定宽高和改形状）。
- 冲突判断靠主进程内存里的版本记录（最近 60 个版本）。应用重启后查不到旧版本，agent 引用已有元素会被要求重新读一次。
- 已修复绑定箭头误判冲突：`elementFingerprints()` 对绑定了节点的箭头按连接关系、折点数、样式和标签文本计算指纹，用户拖动或缩放节点连带拉伸箭头时不再误判连线冲突；真正改了连线文字/样式或挪动节点本身仍会报冲突。
- 用户正在画一笔或编辑文字时，页面最多等 10 秒，超过 400ms 会在画布底部显示非侵入式提示「Agent 有内容要画，松笔/结束文字编辑后更新」，松笔即自动消失。
- 改动对比只在接受时做。拒绝时提议已经删掉，agent 只拿到附言。
- 改动对比按"提议画上去之后"算：两个提议同时挂着时，用户这期间自己加的东西会在两个提议的结果里都出现一次。
- 端到端测试里"用户改提议"是直接改画布数据模拟的，不是真的鼠标拖动。真拖动时连着的箭头会跟着走，模拟的不会（截图 `propose-edited.png` 里那条箭头悬空就是这个原因）。
- agent 画的一批可以用撤销去掉（`CaptureUpdateAction.IMMEDIATELY`），这一点只看了接口说明，没有实际按过撤销验证。

**M2 后面几步**（设计见 design.md 第 4.3、7、12 节）
- M2 的代码到这里做完了。下一步是在真实 agent 会话里走一遍主演示（画草图 → agent 读 → agent 提议 → 用户改一笔接受 → agent 知道改了哪里），再决定 M3 做什么

**其他待定**
- **叫醒 agent 的路线（已定，做到第 1 步）**：
  1. ✅ 点选席位发送 + 剪贴板兜底，三家客户端通用。隔离的测试实例（同时设了 `FLYINGDRAWS_HOME` 和 `FLYINGDRAWS_DEBUG_PORT`）不写系统剪贴板，只把那句话放在 `hub:submit` 的返回值 `hint` 里。
  2. 待做：给 Claude Code 做 channels 适配，让桥接把「某画板更新了，请去读」推进会话。channels 是预览功能，动手前先查文档确认现状。画布到桥接这一段用长轮询（桥接后台挂 `GET /events?seat=…&after=<游标>`），不用 webhook；事件只当门铃，不带画布内容，带递增 `id` 供断线续传。事件通道要单独用一条不复用的连接（见踩坑第 2 条）。
  3. Codex 和 Antigravity 没有公开的会话注入入口，停在第 1 步观望。
- **画布没法主动叫醒 agent**（MCP 是 agent 来问工具）。用户点了"发给 agent"而 agent 没在等时，画只能放在收件箱里（现已持久化到 `pending.json`，重启不丢失），要用户在聊天里说一声。画布上现在会明说这一点：发送前提示"要在聊天里说一声"，发出后显示"已发出，agent 还没来取"，被取走时提示"agent 已经取走你的画"。`canvas_read` 和不带 `request_id` 的 `canvas_wait` 都会取走收件箱里的画和附言。想真正做到"发了就到"，得用 MCP 的资源订阅通知（design.md 第 7 节末尾），而且客户端要支持
- **桥接桌面端寻址链已升级**：按 `FLYINGDRAWS_APP` 环境变量 → 独立包同级 `Flying draws.exe` → 仓库 `dist/Flying-draws-win32-x64/Flying draws.exe` 或 `%LOCALAPPDATA%\Flying draws\Flying draws.exe` → 开发环境 `require('electron')` 依次查找，缺 Electron 时给出清晰指引。
- **多画板当前限制**：目前仍是单窗口渲染，agent 在 `canvas_read`/`draw`/`propose`/`request` 传入非当前 `board` 时会把窗口切换到该画板（且要求该画板已存在，新画板需先通过 `canvas_open` 或界面创建）；支持重命名与删除，但重命名非当前激活画板后窗口不会切过去
- **升级提示**：如果本机之前已经开着旧版 Flying draws 窗口，重新 `npm run build` 后需要重启一次画布应用窗口（或在宿主里重连 MCP），新加的工具和接口才会生效
- 摘要只有中文
- `npm run e2e:draw` 原画板重命名偶发时序问题已修复（测试实例跳过系统窗口吸附以防 `resize` 误关菜单，脚本改用 `until` 状态轮询替代固定 `sleep`）
