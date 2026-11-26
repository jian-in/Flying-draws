# Flying draws 架构与核心工程设计

本文档面向深入理解 **Flying draws** 底层机制的开发者与架构审阅者，结合仓库真实源码拆解项目的整体拓扑与六大核心工程设计。

---

## 全局系统拓扑

Flying draws 同时支撑两条工作流：**外部编码 Agent 的零配置 MCP 空间外设**（Claude Code、Codex、Cursor、Antigravity 等通过 `out/bridge/index.js` 接入），以及**内置 Fuxi 内核的一体化视觉工作台**。两条路径在主进程汇聚到同一套画板会话、乐观并发控制与语义排版引擎上。内置面板的执行后端还可以从 Fuxi 内核切到任意标准 ACP 代理（见第六章），任务记录、圈选上下文与画布席位两种引擎共用。

```mermaid
flowchart LR
  subgraph Ext["外部编码 Agent (MCP Stdio)"]
    CC["Claude Code / Codex / Cursor"]
    BR["MCP Bridge (src/bridge/index.ts)"]
    CC <-->|"stdio JSON-RPC"| BR
  end

  subgraph App["Flying draws 桌面端 (Electron)"]
    DM["Local HTTP Daemon (src/main/daemon.ts)"]
    CORE["BoardSession (src/main/boardState.ts) + 写队列 serialized() (src/main/draw.ts)"]
    SEM["空间语义与像素逆映射 (semantic.ts / imageSize.ts)"]
    OPS["排版、Rebase 与提议转换 (ops.ts / diff.ts / lineage.ts)"]
    DOCK["Win32 物理像素吸附 (dock.ts / koffi)"]
    AG["AgentService (src/main/agent.ts)"]
    UI["Excalidraw 渲染与交互层 (App.tsx / AgentPanel.tsx)"]

    DM <-->|"serialized()"| CORE
    CORE --> SEM
    CORE --> OPS
    CORE <-->|"IPC Snapshot / ApplyPlan"| UI
    DOCK -.->|"DWM Frame + SetWinEventHook"| UI
    UI <-->|"ContextIsolated Preload"| AG
  end

  subgraph Host["独立宿主进程"]
    FX["Fuxi Rust Kernel (NDJSON Host)"]
    ACPX["标准 ACP 代理 (Antigravity / Claude Code / Codex / OpenCode / 自定义)"]
  end

  BR <-->|"127.0.0.1 + Token"| DM
  AG <-->|"stdio NDJSON (agentClient.ts)"| FX
  AG <-->|"stdio JSON-RPC (acpClient.ts)"| ACPX
  FX <-->|"ELECTRON_RUN_AS_NODE Bridge"| BR
  ACPX <-->|"session/new 注入的 MCP Bridge"| BR
```

### 核心模块速查表

| 模块路径 | 工程职责 | 依赖特征 |
|---|---|---|
| `src/bridge/index.ts` | 10 个 MCP 画布工具注册、席位心跳上报、`setup`/`doctor`/`call` CLI、多路径桌面端自动拉起 | Node.js 标准库 + MCP SDK |
| `src/main/ops.ts` | 指令校验、Dagre 自动排版、梁-巴斯基（Liang–Barsky）连线避障、`trace_image` 比例映射、`rebaseOps` 重编号、`elementFingerprints` 指纹、`toProposalPlan` 预览框转换 | 纯函数（仅依赖 `@dagrejs/dagre`） |
| `src/main/semantic.ts` | 阅读序短编号生成、两阶段并查集手绘聚类与标注圈预判、旁注吸附、裁剪/翻转原图像素逆映射（`canvasRectToImagePixels`） | 纯函数，零外部依赖 |
| `src/main/imageSize.ts` | PNG / GIF / WebP（VP8/VP8L/VP8X）/ JPEG / SVG 二进制头部零依赖像素尺寸解析 | 纯函数，零外部依赖 |
| `src/main/diff.ts` | `captureBaseline` 提议底稿快照、`diffProposal` 几何去噪与中文自然语言差异合成 | 纯函数，零外部依赖 |
| `src/main/lineage.ts` | `shouldAutoPlaceResultImage` 画布自拍防递归过滤、`planImageLineage` 多轮 `v1 → v2 → v3` 演进墙横向落位与绑定连线规划 | 纯函数，零外部依赖 |
| `src/main/dock.ts` & `dockGeometry.ts` | `koffi` Win32/DWM FFI、`SetWinEventHook` 跨进程窗口跟随、`DWMWA_EXTENDED_FRAME_BOUNDS` 跨 DPI 隐形边框二次校准 | 主进程（Windows 原生 API） |
| `src/main/daemon.ts` & `atomicWrite.ts` | `127.0.0.1` 防重绑定 HTTP 服务、常量时间 Token 鉴权、单文件路径串行队列原子写 | Node.js 标准库 |
| `src/main/agentClient.ts` & `agent.ts` | 内置 Fuxi 子进程 NDJSON 协议栈、双阶段请求结算、执行与审批通道分离、会话/血缘持久化、Fuxi / ACP 双引擎调度 | Node.js 标准库 |
| `src/main/acpClient.ts` | 标准 ACP stdio JSON-RPC 客户端、预设 CLI 探测与 `resolveAcpCommand` 命令解析、Windows `.cmd/.bat` 逐字转义启动、会话恢复能力协商 | Node.js 标准库 |

---

## 一、双向提议对齐协议（Proposal-Diff Protocol）

**涉及源码**：`src/main/ops.ts`、`src/renderer/src/canvas/proposal.ts`、`src/renderer/src/App.tsx`、`src/main/diff.ts`、`src/main/pending.ts`

### 1. 设计动机
普通画图 MCP 工具只有单向输出（Agent 直接覆写画布），一旦理解偏差就会破坏用户手绘草图；而退回聊天框用文字逐条请示又割裂了空间直觉。Flying draws 设计了类 Git PR Review 的**画布原位提议与手改回流协议**：Agent 把新增与改删意图以「半透明可交互草稿」投射到画布，用户可以直接在提议上拖拽、改字、局部剔除单条修改，画布在确认瞬间自动把人类手改行为编译回自然语言 Diff。

### 2. 三阶段核心机制

```mermaid
sequenceDiagram
  participant A as Coding Agent
  participant M as Main (ops.ts / diff.ts)
  participant R as Renderer (App.tsx / proposal.ts)
  participant U as User (Excalidraw)

  A->>M: canvas_propose(ops, question, base_version)
  M->>M: planOps() -> toProposalPlan() 剥离改删至 PendingChanges
  M->>R: applyPlan(plan, proposalId)
  R->>U: 渲染半透明虚线新元素 + 虚线预览框 (role="marker")
  M->>M: captureBaseline() 记录几何/文本/端点字典并持久化 pending.json
  M-->>A: 返回 request_id

  A->>M: canvas_wait(request_id)
  U->>U: 拖拽节点 / 修改文字 / 删掉单处红色删除框 / 补画新框
  U->>R: 点击「对，就这样」
  R->>R: resolveProposal() 检查存活 frameId，执行保留项，收集 skipped
  R->>M: hub:submit(accepted, sceneJson, skipped)
  M->>M: diffProposal(baseline, now) 几何去噪合成中文差异
  M-->>A: status="submitted", decision="accepted", changes=[...]
```

1. **破坏性操作延迟化与预览标记框（`toProposalPlan`）**
   - `canvas_propose` 与 `canvas_draw` 共享同一套 `planOps()` 校验与排版管线。当进入提议模式时，`toProposalPlan()` 将 `updates`、`textEdits`、`styles`、`deletes` 全部拦截并转存进 `PendingChanges`（随 `~/.flyingdraws/pending.json` v2 格式原子落盘，跨重启不丢）。
   - 针对每一组被改删的目标元素 `targetGroups`（例如一组多笔手写字共用一个分组），计算联合包围盒并外扩 `MARKER_PAD = 10px`，生成虚线矩形预览框 `PlannedMarker` 与顶部 `-26px` 处的中文意图说明（删除框为 `#e03131` 红色、其余改动为席位色，透明度 `75%`，成组 ID `fd_mk_<frameId>`，标记 `customData.flyingdraws.role = 'marker'`）。
   - 新增元素打上 `layer: 'proposal'`（`55%` 透明度 + 虚线；若来自 `trace_image` 则保留原图配色与 `traced: true` 标记）。语义层 `buildGraph()` 通过 `!isMarker(el)` 过滤全部预览框，确保未决标记框绝不污染后续图结构。

2. **细粒度局部否决（`resolveProposal`）**
   - 用户审阅提议时，如果同意整体方案但反感其中某一处删除或改名，只需直接在画布上选中并按 `Delete` 删掉那一个预览框。
   - 点击「对，就这样」时，`src/renderer/src/canvas/proposal.ts` 中的 `resolveProposal()` 扫描当前未删除元素集合 `liveIds`：仅当 `liveIds.has(m.frameId)` 成立时才将其 `m.targets` 纳入 `approvedTargets` 交由 `applyChanges()` 落地；被用户手动删掉的标记框则自动转化为 `"不同意" + m.summary`（如 `不同意删除节点「登录」`），随后统一清理剩余标记框并将提议层新元素转正为 `layer: 'final'`（恢复 100% 不透明度与实线，同时保留 `trace_image` 原有的虚线属性）。

3. **抗手抖几何去噪与语义 Diff 合成（`captureBaseline` & `diffProposal`）**
   - 提议落盘瞬间，`captureBaseline()` 提取提议元素的初始快照 `ProposalBaseline`，不仅记录 `(x, y, w, h, label, from, to)`，还提前把连线两端关联元素的可读名称缓存在 `names: Record<string, string>` 字典中（即使确认前用户把连线指向的旧节点删了，Diff 依然能准确说出「把连线『网关』→『鉴权』改成了…」），同时拍下全画布 `elementIds` 快照。
   - 确认时，`diffProposal()` 对比当前画布与底稿，内置两道抗噪阈值：
     - **位移阈值 `MOVE_THRESHOLD = 24`（px）**：按元素中心点欧氏距离 `Math.hypot(dx, dy) >= 24` 判定有效挪动并推导中文方向（如 `往右下挪了`），过滤鼠标点击选中时的微米级手抖；
     - **缩放阈值 `RESIZE_THRESHOLD = 0.25`（25%）**：宽高相对变化率达 25% 才报告 `改了节点…的大小`；
     - **因果去重**：若连线断开是因为端点节点本身被用户删除，`rewired` 检查 `!byId.has(before)` 自动抑制冗余断连播报；同时扫描不在初始 `elementIds` 内且 `author !== 'agent'` 的元素，汇总用户顺手补画的节点、文字、连线与涂鸦，最终拼成高信噪比中文修订列表回传 Agent。

---

## 二、基于语义指纹的乐观并发控制（Semantic Rebase & Fingerprinting）

**涉及源码**：`src/main/boardState.ts`（`VersionRecord`）、`src/main/draw.ts`（`remember`、`drawOps`）、`src/main/ops.ts`（`rebaseOps`、`elementFingerprints`）

### 1. 工程痛点：短编号漂移与 Excalidraw 派生版本膨胀
直接让大模型读写 Excalidraw 的 21 位随机 ID 极易产生拼写幻觉，因此语义层按阅读顺序（`readingOrder`：行高容差 `40px` 分行后从左到右）实时编号为 `N1, N2 / T1 / S1 / I1`。这带来两个棘手的并发挑战：
1. **阅读序编号漂移**：Agent 基于 `v5` 准备修改 `N2`，但用户在 Agent 思考期间在画布左上角随手补了一个框升到 `v6`，原来的 `N2` 此刻变成了 `N3`；
2. **绑定箭头伪冲突陷阱**：用户在画布上只是把无关节点或目标节点稍微拖开了一点位置，Excalidraw 引擎会自动重算所有绑定在该节点上的 `arrow` 端点坐标与绑定文字位置，连带把这些箭头的 `element.version` 全部递增——如果直接用 `element.version` 做乐观锁，任何拖动都会导致连线操作大面积误报冲突。

### 2. 滑动版本窗口、Rebase 与语义指纹

```mermaid
flowchart TD
  REQ["收到 canvas_draw / canvas_propose (ops, base_version)"] --> SNAP["serialized 队列内拉取最新画布快照 ver"]
  SNAP --> CMP{"base_version === ver ?"}
  CMP -->|"是"| PLAN["直接执行 planOps()"]
  CMP -->|"否"| HIST{"history 窗口 (最近 60 版) 命中 base_version ?"}
  HIST -->|"未命中且引用了已有元素"| CONF1["返回 status='conflict' + 最新画板描述"]
  HIST -->|"命中 VersionRecord"| REBASE["rebaseOps(): 旧短编号 -> 稳定 ref -> 当前短编号"]
  REBASE --> GONE{"存在已删除目标 (gone.length > 0) ?"}
  GONE -->|"是"| CONF2["返回 status='conflict' (指明被删元素原名)"]
  GONE -->|"否"| PLAN2["基于重编号后的 ops 执行 planOps()"]
  PLAN2 --> MOD{"存在写操作目标 (modifiedRefs) ?"}
  MOD -->|"否 (仅连线/旁注/照图参照)"| EXEC["放行渲染 applyPlan()"]
  MOD -->|"是"| FP["对比 elementFingerprints(base) vs elementFingerprints(now)"]
  FP -->|"指纹一致"| EXEC
  FP -->|"指纹不一致"| CONF3["返回 status='conflict' (指明被他人修改的元素)"]
```

- **内存版本窗口（`VersionRecord`）**：每次主进程通过 `describe()` 生成画板描述时，`remember()` 在当前 `BoardSession.history`（LRU 滑动窗口 `HISTORY_LIMIT = 60`）存入 `{ nodes, fingerprints }`。其中手绘笔画组 `strokeGroups` 绑定首笔 `g.refs[0]`，只要首笔仍在，即便组内序号重排也能精确追踪。
- **自动重编号（`rebaseOps`）**：当 `base_version !== ver` 时，`rebaseOps()` 将指令中的旧短编号（含 `N* / T* / S* / I*`）经历史表反映射回底层稳定 `ref`，再投射到当前最新 `SemanticGraph` 的新短编号；通过稳定元素 ID 直接引用的图片（如内置面板发起的 `trace_image`）走 `stableRefs` 通道，天然免疫版本漂移。
- **读写分离锁粒度**：`DrawPlan` 严格区分 `existingRefs`（只读锚点，如向已有节点连一条新边 `add_edge`、挂一段 `add_text`、或 `trace_image` 对照原图）与 `modifiedRefs`（写目标：`update_* / delete_* / set_style`）。只读锚点只要元素未删即无锁放行；仅 `modifiedRefs` 进入指纹比对。
- **绑定箭头语义指纹（`elementFingerprints`）**：
  - 对节点、独立文字、手绘与未绑定箭头，指纹取 `${el.version ?? 0}:${boundText?.version ?? ''}`；
  - 对存在 `startBinding` 或 `endBinding` 的绑定箭头，抛弃易受端点牵连的 `el.version`，改用**拓扑与样式不变量**构造指纹：
    `bound-arrow | startElementId | endElementId | startArrowhead | endArrowhead | points.length | freeStart | freeEnd | strokeColor | strokeStyle | strokeWidth | opacity | layer | labelText+color+fontSize`
  - 由此，用户拖拽节点引发的箭头随动拉伸不会误判连线冲突，而真正修改连线标签、增删折点、改色或重绑端点则 100% 精准拦截。

---

## 三、混合空间语义层与像素逆映射（Spatial Semantic & Pixel Back-Projection）

**涉及源码**：`src/main/semantic.ts`、`src/main/imageSize.ts`、`src/main/ops.ts`、`src/main/lineage.ts`

### 1. 两阶段手绘聚类与「标注圈预判」防吞并
用户在画布上手写批注并用红圈圈起来时，朴素的距离或包围盒聚类会把外围红圈和内部手写字合并成同一个「涂鸦团」，丢失「圈选」这一核心交互语义。`semantic.ts` 采用两阶段几何分析解决该问题：
- **负向采样点外接框修正（`bboxOf`）**：Excalidraw 的 `freedraw / line / arrow` 以落笔点为 `(x, y)`，用户往左或往上运笔时 `points` 为负值而 `width/height` 仍存正数。`bboxOf()` 直接扫描全体 `points` 极值重建真实物理包络。
- **阶段一：标注圈预判冻结（`isAnnotationLoop`）**：先用首尾距离 `< 0.2 * diag`（且对角线 `diag >= 24`）识别闭合圈 `loop`；若该闭合圈包含了任意节点、独立文字、图片，或包含了尺寸更小的其他笔画（`other.diag < s.diag * 0.85`），即判定为**标注圈**并从后续并查集中隔离。同时在并查集合并时拦截 `diag >= 60` 且尺寸比超过 `2.5x` 的大小笔画粘连。
- **阶段二：自适应采样并查集聚类**：对非标注圈笔画，每笔均匀抽取最多 `GROUP_SAMPLE_POINTS = 24` 个点（用点距代替外接框重叠），按自适应阈值 `gap = clamp(min(diag_i, diag_j), 30, 150)` 合并邻近笔画为手写组 `S1..Sk`，随后再让单笔标注圈统一结算 `encloses`，稳定输出「`S2 一个圈，圈住了 S1（一组手写，5 笔）`」。

### 2. 零依赖二进制图像头解析与裁剪/翻转逆映射
当用户把 2560×1440 的网页截图拖进画布缩放到 640×360、甚至裁剪（`crop`）或镜像翻转（`scale`）后在上面画红圈时，直接给大模型传画布坐标会导致严重定位偏移。
- **零依赖图像头解析（`src/main/imageSize.ts`）**：不引入 `sharp` 等原生编译包，直接按字节解析 PNG（`IHDR` chunk 偏移 16..24 大端宽高）、GIF87a/89a、WebP（覆盖 `VP8 ` 有损关键帧帧头、`VP8L` 14-bit 位打包与 `VP8X` 24-bit 扩展块）、JPEG（流式扫描 `0xFF` 段直至 `SOF0..SOF15`，对 Base64 DataURL 仅截取前 96KB 切片解码，PNG/WebP 仅取前 128 字符）及 SVG `width/height/viewBox`，零开销获取原图 `naturalSize`。
- **仿射逆映射（`canvasRectToImagePixels` & `canvasPointToImagePixels`）**：
  1. 求画布批注框（红圈、矩形框、箭头尖端、图上文字或手写组）与画布图片框 `imgBbox` 的交集，计算归一化UV比例 $u \in [0, 1], v \in [0, 1]$；
  2. 若图片存在水平或垂直翻转（`scale[0] < 0` 或 `scale[1] < 0`），执行镜像反演 $[u_0, u_1] \leftarrow [1 - u_1, 1 - u_0]$；
  3. 投射到裁剪源矩形 `src`（若开启裁剪则为 `el.crop`，否则为 `0, 0, naturalWidth, naturalHeight`），输出精准到原图像素的 `pixelBbox` 与 `pixelPoint`（`ImageRegionAnnotation`）。
- **正向比例还原（`trace_image`）**：反向同理，Agent 只需在原图像素坐标系 `space: { w, h }` 下描述看到的 `box / text / line`，`planTrace()` 自动按 `sx = box.w / space.w, sy = box.h / space.h` 缩放坐标与字号，默认通过 `placeBlock` 摆在原图右侧空位并保留原图十六进制配色。

### 3. 多轮视觉演进墙与防递归上墙（`src/main/lineage.ts`）
- **防画中画死循环（`shouldAutoPlaceResultImage`）**：内置 Agent 既会调用 `render_page` / `browser_page` 产出网页渲染截图，也会调用 `canvas_read` 获取画布自身截图。`shouldAutoPlaceResultImage()` 根据工具名与 `toolLabels` 映射严格剔除 `canvas_read` / `canvas_list` 等画布自省工具，确保只有外部页面/产物截图才会触发自动上墙。
- **演进树自动排版（`planImageLineage`）**：
  - **幂等防重**：检查画布存活元素中是否已有 `customData.flyingdraws.result === image.id`，确保自动上墙与手动点击「`放到画布 ↗`」零重复插入；
  - **血缘寻址与横向生长**：优先匹配本轮圈选原图的稳定 ID `sourceImageRef`，其次回溯同一 `workItemId` 下最近一轮（`round < current`）的结果图作为父锚点；新图自动落位在父图右侧 `parent.x + parent.w + 160`（遇障碍自动向右步进或换行）；
  - **改动证据链与作者筛选兼容**：同步生成绑定父子图片的 Excalidraw 箭头（标签自动提取本轮 `write_file / edit_file / apply_patch` 涉及的最多 4 个短文件名，如 `第 2 轮 · App.tsx, styles.css`）及图片顶部题注（如 `v2 · 1280×720`），统一打上 `author: 'agent', agent: AGENT_SEAT, seat: true, layer: 'final'`，与底部作者筛选器 100% 兼容。

---

## 四、Win32 物理像素伴随吸附引擎（DWM Frame-Aligned Docking）

**涉及源码**：`src/main/dock.ts`、`src/main/dockGeometry.ts`

把画布窗口拖到 VS Code、终端或浏览器窗口侧边松手（距离 `<= 32px` 且垂直重叠 `>= 30%`，剩余工作区宽度 `>= 420px`），画布即刻贴合到目标窗口旁，随目标窗口移动、缩放、置顶而实时伴随，一拖开立即脱开不粘手。

1. **纯几何层与系统 FFI 解耦**：`dockGeometry.ts`（`snapSide`、`dockedRect`、`pickTarget`）全部定义为纯物理像素矩形运算，脱离 Electron 与 Windows 环境即可在任意平台跑单元测试；`dock.ts` 通过 `koffi` 直接加载 `user32.dll` 与 `dwmapi.dll`，无需编译原生 Node C++ 插件。
2. **严苛的候选窗口过滤（`candidates`）**：按 Z-Order 从顶向下扫描窗口栈，利用 `IsWindowVisible`、`IsIconic`、`DwmGetWindowAttribute(DWMWA_CLOAKED)` 剔除隐藏窗口、最小化窗口以及 Windows 10/11 跨虚拟桌面隐身窗口与挂起的 UWP 外壳，同时过滤 `WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT` 浮层与 `Progman / WorkerW / Shell_TrayWnd` 系统外壳。
3. **跨 DPI 显示器隐形阴影边二次校准（`DWMWA_EXTENDED_FRAME_BOUNDS`）**：
   - Windows 10/11 顶层窗口的 `GetWindowRect`（`outer`）四周包含一圈约 7px（随屏幕缩放率 100% / 150% / 200% 动态变化）的透明缩放手柄阴影，而人眼看到的真实边框是 `DWMWA_EXTENDED_FRAME_BOUNDS`（`frame`）。若直接调用 Electron 的 DIP 坐标 `win.setBounds()`，在混合 DPI 双屏环境下会出现明显白缝或边缘重叠。
   - `WindowDock.apply()` 直接基于物理像素工作区（`MonitorFromRect` + `GetMonitorInfoW`）求出期望视觉框 `want`，用 `pad = calcPad(frame, outer)` 换算外部补偿并调用 `SetWindowPos(..., SWP_NOZORDER | SWP_NOACTIVATE)`；紧接着**立即二次回读 `frame2` 与 `outer2`**——若窗口刚跨入另一块不同 DPI 的显示器导致系统重算了隐形边框厚度（`!samePad(pad, pad2)`），当场以新 `pad2` 执行第二次 `SetWindowPos` 微调，实现跨屏零缝隙像素级贴合。
4. **事件钩子驱动与零开销休眠**：
   - 仅在进入吸附态后注册 `SetWinEventHook`（`WINEVENT_OUTOFCONTEXT`），监听目标窗口 `EVENT_OBJECT_LOCATIONCHANGE` 与全局焦点切换 `EVENT_SYSTEM_FOREGROUND`（当目标窗口切回前台且画布被遮挡时，调用 `win.moveTop()` 非抢焦点浮出），辅以 500ms 低频兜底检查（若系统禁用 Hook 则自动降级为运动态 16ms / 静止态 120ms 自适应轮询）。
   - 用户拉动外侧边调整画布宽度时启动 `250ms` 防抖窗口平滑记忆新宽度；拉动贴合缝隙超过 `SEAM_DETACH_TOL_PX = 4px`、拖移画布或隐藏窗口时，立即调用 `UnhookWinEvent` 与 `koffi.unregister` 销毁全部钩子和定时器（若正处于回调栈内则通过 `setImmediate` 安全延后释放），未吸附与后台常驻期间 CPU 轮询开销严格为零。

---

## 五、双通道隔离与本地安全模型（Dual-Channel Isolation & Local Security）

**涉及源码**：`src/main/daemon.ts`、`src/main/atomicWrite.ts`、`src/bridge/index.ts`、`src/main/agentClient.ts`、`src/main/agent.ts`、`src/preload/index.ts`

1. **回环网络与反 DNS Rebinding 纵深防御（`daemon.ts`）**
   - 本地服务硬编码绑定 `server.listen(0, '127.0.0.1')`，绝不暴露局域网网卡。
   - 请求入口实施四重校验：
     1. **禁绝浏览器跨域探测**：凡携带 `Origin` 请求头一律返回 `HTTP 403`；
     2. **阻断 DNS 重绑定攻击**：强校验 `req.headers.host?.startsWith('127.0.0.1:')`，即使攻击者页面将恶意域名解析至 `127.0.0.1` 也会因 `Host` 头不匹配被当场拒绝；
     3. **常量时间凭据比对**：启动时生成 24 字节密码学随机 hex Token，通过 `crypto.timingSafeEqual` 校验 `x-flyingdraws-token` 请求头（`daemon.json` 以 `0o600` 权限写临时文件后原子 `rename` 落盘，退出时核对 `pid === process.pid` 清理）；
     4. **负载熔断**：除 `/health` 探针外仅接受 `POST` JSON，请求体超过 `MAX_BODY = 1 MiB` 立即返回 `HTTP 413` 并销毁底层连接。
   - **桥接侧代理绕行与帧隔离（`src/bridge/index.ts`）**：显式使用 `node:http` 而非全局 `fetch`（规避终端环境变量 `HTTP_PROXY` 将回环流量误导向外部代理），且对 `/health` GET 探针严禁附加 `Content-Length`，防止 HTTP Keep-Alive 连接复用时产生请求体帧错位。

2. **单文件路径串行原子写（`atomicWrite.ts`）**
   - 渲染器定时自动保存、MCP 并发读取触发的快照落盘、以及多画板切换可能在同一毫秒写同一个 `.excalidraw` 或 `pending.json` 文件。
   - `atomicWriteJson` 在入队瞬间完成 `JSON.stringify` 快照固化（防止异步排队期间内存对象被篡改），按目标路径在 `chains: Map<string, Promise<void>>` 中串行排队，依次写入 `<file>.<pid>.<seq>.tmp` 再执行文件系统级原子 `rename`，杜绝半截 JSON 损坏与并发抢临时文件引发的 `ENOENT`。

3. **渲染沙箱与内置 Fuxi 宿主进程隔离（`agentClient.ts` & `agent.ts`）**
   - **最小权限渲染沙箱**：`BrowserWindow` 强制开启 `contextIsolation: true` 与 `sandbox: true`，`src/preload/index.ts` 仅映射类型受控的画板与任务业务方法，渲染层无任何 Node.js、任意文件读写或 Shell 执行权限；外部链接统一由 `setWindowOpenHandler` 拦截。
   - **NDJSON 宿主生命周期与双通道控制**：内置 Fuxi 内核以独立无界面子进程（`fuxi --host --host-data ~/.flyingdraws/agent`）运行，`stderr` 流实时排空不落盘以防日志泄露环境凭据，`stdout` 实施单行 `10 MiB` 熔断上限。任务执行请求采用 `accepted + done` 双阶段异步结算，而任务取消（`cancel`）与高风险工具逐次审批（`approve`）走独立 JSON-RPC 请求序号直达内核，执行阻塞期仍可毫秒级中断。
   - **崩溃安全恢复**：应用退出时经 `before-quit` 发起 `shutdown` 握手，超时 12 秒自动升级为 `taskkill.exe /PID <pid> /T /F` 清理整棵工具子进程树；下次启动读取 `work-items.json` 时，所有遗留的 `running` / `planned` 状态一律降级为 `interrupted` 并作废未决审批，绝不在用户不知情时静默重放未完成动作。

---

## 六、标准 ACP 代理接入（Agent Client Protocol Backends）

**涉及源码**：`src/main/acpClient.ts`、`src/main/agent.ts`、`src/shared/agent.ts`、`src/main/agentIpc.ts`

内置面板的执行后端除了 Fuxi 内核，还可以切到任何实现了标准 ACP 的本地代理：内置 Antigravity、Claude Code、Codex、OpenCode 四个预设，另可填写自定义代理。两种引擎共用任务记录、圈选上下文、改动快照与画布席位；ACP 一侧要额外解决的，是安全地启动一个不归应用管的外部程序，并在协议能力参差不齐的代理之间守住三条约束：**不悄悄换会话、不替用户留下永久授权、停止后旧轮不混进下一轮**。

```mermaid
sequenceDiagram
  participant S as AgentService (agent.ts)
  participant C as AcpClient (acpClient.ts)
  participant P as ACP 代理子进程
  participant U as 用户 (AgentPanel)

  S->>S: resolveAcpCommand() + reviewAcpLaunch()（非默认启动首次弹确认）
  S->>C: start()
  C->>P: initialize（fs / terminal 能力均声明为 false）
  S->>P: session/resume → session/load，或 session/new（注入 flying_draws MCP）
  U->>S: 拟计划 / 直接执行
  S->>P: set_config_option 或 set_mode → plan（仅规划轮）
  S->>P: session/prompt（不设总时限）
  P-->>S: session/update（回复 / 思考 / plan / tool_call / 用量）
  P->>S: session/request_permission
  S-->>U: 审批卡（或按 YOLO / 任务规则直接答 allow_once）
  U->>S: 停止
  S->>P: 挂起审批全部答 cancelled，再发 session/cancel
  alt 宽限期内结束本轮
    P-->>S: session/prompt 返回 stopReason
  else 宽限期超时（默认 8 秒）
    S->>C: abandonAcpRun()：断开 → 等旧进程退出 → 结算快照 → 后台重连
  end
```

### 1. 进程与连接：stdio JSON-RPC 与启动信任

- **协议栈（`AcpClient`）**：代理以无窗口子进程运行，`stdin/stdout` 上按行收发 JSON-RPC 2.0 帧，单帧沿用 `10 MiB` 熔断；`initialize` 完成前的非 JSON 行视为 CLI 启动日志忽略，完成后再出现即判定协议错误并结束进程。`stderr` 只保留末尾 1200 字符供启动诊断。`initialize` 把 `fs.readTextFile / writeTextFile` 与 `terminal` 都声明为 `false`：宿主不代理文件和终端，代理用自己的工具直接读写工作区，所以本轮改动只能靠工作区快照结算（见第 5 节）。代理发来的反向请求只接 `session/request_permission`，其余一律回 `-32601`。代理返回 `-32000`（需要认证）时，内置预设提示对应 CLI 的登录命令，自定义代理改为展示它自己在 `authMethods` 里给的认证说明。
- **预设探测与命令解析（`detectAcpPresetBinary` / `resolveAcpCommand`）**：

  | 预设 | 自动探测的命令 | 默认参数 | 默认席位 | 认证报错时的提示 |
  |---|---|---|---|---|
  | Antigravity | `agy`（可用环境变量 `FLYINGDRAWS_ACP_BIN` 覆盖） | `acp` | Antigravity | `agy acp --login` |
  | Claude Code | `claude-agent-acp`、`claude-code-acp` | 无 | Claude | `claude login` |
  | Codex | `codex-acp` | 无 | Codex | `codex login` |
  | OpenCode | `opencode` | `acp` | OpenCode | `opencode auth login` |
  | 自定义 | 不探测，必须填写 | 用户填写 | ACP | 代理自己的 `authMethods` |

  命令留空时按预设在 PATH、npm 全局目录、`~/.local/bin` 等标准用户安装位置查找，不写死任何用户名路径。填了命令时：裸命令名只在 PATH 里找，且只认 PATH 中的绝对路径目录（`.`、`bin` 这类相对目录随启动目录指向不同位置，跳过）；带路径分隔符的一律先 `resolve()` 成绝对路径并要求文件存在——确认框、信任指纹和实际 `spawn` 用的是同一个绝对路径，同一串相对路径换个启动目录指向别的程序时，指纹随之不同，会重新确认。
- **首次启动确认与信任指纹（`reviewAcpLaunch` / `acpLaunchFingerprint`）**：内置预设、命令留空自动探测、参数与默认值逐项一致，这种启动由应用自己决定，直接放行。其余情况（自定义程序、改过参数、旧版留下或手改设置文件得到的命令）以 `sha256(JSON.stringify([绝对路径, ...args]))` 为指纹；指纹不在信任列表里时，由主进程原生对话框（`agentIpc.ts` 的 `confirmAcpLaunch`）逐行列出实际程序和每个参数，默认按钮是「取消」；没有注入确认回调时一律不启动。确认后指纹写入 `host-settings.json` 的 `acpTrusted`（最多保留 50 条，读取时只认 64 位十六进制串）。席位名不参与指纹，只改席位或重连不会再问。切换引擎、修改 ACP 配置、打开属于另一预设的历史任务时都先做这一步预检，用户取消则原连接和配置原样保留。
- **Windows 批处理启动（`windowsBatchLaunch`）**：npm 全局安装的代理多是 `.cmd` 垫片，不能直接 `spawn`。宿主自己拼整条命令行交给 `ComSpec`（`cmd.exe /d /s /c "<line>"`），并开启 `windowsVerbatimArguments` 关掉 Node 的二次加引号：程序路径按 cmd 元字符加 `^`；每个参数先按 MSVC 规则加引号（引号前的反斜杠成对），再转义 cmd 元字符，规则与 cross-spawn 一致。路径和参数里的空格、引号、`&`、`%` 保持原样，参数边界不会被 cmd 拆开或合并。
- **画布工具注入与看图能力**：`toAcpMcpServers()` 把应用的 MCP 配置转成 `session/new` 要求的数组格式，并把 `flying_draws` 桥接的 `FLYINGDRAWS_SEAT` 覆盖为当前 ACP 配置的席位名（默认取预设席位，可在设置里改），代理在画布上画的内容按自己的席位署名。只有代理在 `promptCapabilities.image` 里明确声明 `true` 时才附画布截图，缺省只发文字（目标、选区和画布结构已写在文字里）。
- **结束进程（`stop`）**：有活动会话且代理声明了 `session/close` 能力时先关会话（2 秒上限），再关闭 `stdin`；4 秒内仍未退出则结束整棵进程树（Windows 上为 `taskkill /T /F`，其他平台先 `SIGTERM` 再 `SIGKILL`），每一步之后都确认进程是否真的退出。`stop()` 返回进程是否已经退出，强停命令也失败时返回 `false`，调用方不能当作已结束（见第 5 节）。

### 2. 会话：恢复优先、失败不换会话、只读查看

- **任务与预设绑定**：每项任务记录 `engine` 与 `acpPreset`，会话 ID 只在同一预设下续接，不会把一个代理的会话 ID 交给另一个代理。打开另一预设（或另一引擎）的历史任务时，先换回那个预设保存的配置（未确认过的命令照样先问），再连接。
- **恢复顺序（`resumeOrLoadSession`）**：有原会话 ID 时，按代理在 `initialize` 里声明的能力依次尝试 `session/resume`、`session/load`。`load` 会先把历史对话作为 `session/update` 回放，此时没有进行中的轮次，宿主直接丢弃这些通知。两条都走不通时区分两种失败：两项能力都没声明为 `unsupported`，声明了但请求报错为 `error`。没有原会话时走 `session/new`；切到新会话后，旧会话在代理支持时 `session/close`。
- **恢复失败（`acpResume`）**：不悄悄换成新会话，也不改写原任务的会话 ID。`markAcpDetached()` 让面板照常显示这项任务的记录，同时置 `acpResume = { itemId, reason, message }`，发送与确认执行都被 `requireWritableTask()` 拦下：`error` 提示重试恢复或开始新任务（再点一次这项任务即用原会话 ID 重试），`unsupported` 提示只能查看、请开始新任务。唯一例外是应用自动连接（不是用户主动打开）时遇到 `unsupported`：直接开新会话并给出提示，旧任务留在列表里，免得每次启动都卡在一项注定无法恢复的任务上。
- **打开历史任务先选中**：任务记录在本机，`openTask()` 先把它设为当前任务再连接；代理或内核启动失败、连接报错时，面板照样显示这项任务的记录，只是不能发送（任务下拉框在未连接时也可操作，发送和执行仍受连接状态约束），重连后接着这项任务（重连时优先用当前选中的任务，没有才取这块画板最近的一项）。
- **只读历史任务（`readOnlyTask`，两种引擎共用）**：用户主动打开或正选着的历史任务，工作目录已不存在或无法访问时，不在别的目录里接着它的会话：`markReadOnly()` 按引擎走 `markFuxiReadOnly()`（不打开工作区）或 `markAcpDetached()`（不恢复会话），统一置 `readOnlyTask`，记录可看、不能接着发。`openTask()` 发现目录不在时直接只读显示，不为它启动或连接代理，代理没在运行时连接状态如实显示为未连接。目录放回原处后点「重新检查」（或再点这项任务）即重试。若不是用户的任务（例如应用自动连接时最近一项任务的目录没了），则改用应用专用工作目录开新会话，并提示原记录已保留。只读期间内核发来的 `session_reset` 不改这项任务的会话 ID。
- **会话切换使计划失效**：每次切换会话或打开工作区失败，所有 `planned` 轮次都降为 `interrupted`，计划要在新会话里重新拟定。连接意外断开时，进行中和待确认的轮次同样降为 `interrupted`（尚未确认的工具结果保持未知），挂起的审批一律作废；已经收到的回复和思考先并入正文，进行中的轮次照常结算改动快照并落盘，结算完才放开下一轮（见第 5 节）。

### 3. 规划与执行：借用代理自己的规划模式

ACP 没有「先拟计划、确认后执行」的协议原语，宿主借代理声明的规划模式实现这一流程：

- **规划入口（`acpPlanTarget`）**：`configOptions` 里的 `mode` 选项含 `plan` 值时优先用 `session/set_config_option` 切换，其次是 session modes 里的 `plan`（`session/set_mode`）；两者都没有就直接报「不能先拟计划，请直接执行」，本轮不发送。
- **切换时机（`prepareAcpMode`）**：规划轮先切进 `plan`，切成功才发 `session/prompt`，并记下切换前的模式 `acpPrePlanMode`（记不到时用 `acpFallbackMode` 兜底：有 `default` 用 `default`，否则取第一个非规划模式）。确认执行或规划后直接发新任务时，只在代理仍停在 `plan`（或没报告当前模式）时才切回规划前的模式；代理已经自己退出规划、或用户之后改过模式，都以当前模式为准。用户在面板上明确选过模式会清掉 `acpPrePlanMode`：之后直接发的新任务停在用户选的模式（哪怕选的就是 `plan`），确认执行时代理若仍在 `plan` 则用兜底模式退出规划；新会话的初始模式由代理决定，同样清掉。任何一次切换失败都抛出具体原因，本轮不发送。
- **计划内容（`plan` 更新，仅规划轮采用）**：协议要求代理每次都发完整的计划列表、由客户端整体替换。宿主照此把条目渲染为勾选清单覆盖 `run.plan`；空列表即代理撤回了全部步骤，计划随之清空。规划轮以 `end_turn` 结束时，有计划才进入 `planned` 等待确认，否则标为失败并提示补充说明：本轮发过结构化计划的，只认结构化步骤，撤回成空列表后回复只是说明，不能当计划确认执行（回复照常保留）；从没发过结构化计划的代理，回复正文就是计划。
- **确认执行**：在同一会话里追加一轮「已确认上述计划，请按计划开始执行」（可附补充说明），并像普通执行轮一样先拍工作区快照。

### 4. 审批：只选「允许一次」，记忆规则留在宿主

- **只选 `allow_once`（`acpAllowOnceOption`）**：「本次允许」与「本任务内都允许」都只向代理回 `allow_once`（选项缺 `kind` 时按名称排除 always / 永久 / reject 一类）；YOLO 模式和任务规则自动放行时也一样。代理只提供永久授权时，宿主不替用户选，必须由用户明确点「始终允许」。拒绝只选 `reject_once`，代理没有单次拒绝选项就回 `cancelled`，不在代理那边留下长期规则。
- **任务内记忆的匹配键（`acpRuleKey`）**：「本任务内都允许」记在任务的 `allowedCommands` 里，匹配键为 `acp:` + `sha256(JSON([kind, title]) + 完整参数的键排序 JSON)`。审批卡上最多 8000 字符的参数预览只给人看，不参与判断：两次写文件前 8000 字符相同、末尾不同，必须重新询问。代理可能先在 `tool_call` 里发标题、后在 `tool_call_update` 里补参数，宿主按 `toolCallId` 逐项合并，审批请求缺哪一项就用它补上。没有工具标题（`kind` 只是读、改、执行这类工具类别，不算身份）、没有参数或参数无法序列化时不给匹配键，这条调用只能单次允许；没有匹配键的旧 ACP 规则不再自动放行。
- **停止后与跨会话的审批**：已点停止（代理尚未回应取消）、没有进行中的轮次、请求没带 `sessionId` 或不是当前会话，或请求来自已被放弃的旧连接，一律答 `cancelled`，不按 YOLO 或任务规则放行，也不弹卡。

### 5. 停止与收尾

- **取消与宽限期**：点停止时，宿主按协议先把挂起的审批全部答成 `cancelled`，再发 `session/cancel` 通知，并启动宽限计时（默认 8 秒，构造选项 `acpCancelGraceMs` 可调）。`session/prompt` 本身不设总时限（一轮可能要等用户审批很久），停止完全依赖这条路径。
- **放弃旧连接（`abandonAcpRun`）**：宽限期内代理没结束本轮时，宿主先断开：清空当前连接与会话 ID，旧连接迟到的 `session/update` 被忽略、迟到的审批答 `cancelled`，已流式收到的回复并入正文。`busy` 与取消标记则一直保持到旧进程真正退出，这期间面板不会自动重连、也发不了下一轮，新连接不可能和仍在写文件的旧进程同时接手同一个会话。旧进程退出后，先等结果图写盘、结算本轮改动快照，再把本轮标为 `cancelled`（附「代理没有响应停止请求」说明），最后在后台重连，有恢复能力的代理会接回同一个会话。强停也失败、旧进程可能还活着时，本轮同样标为 `cancelled` 并说明原因，但不自动重连：宿主记下这个进程（`acpStuck`），它退出之前任何连接请求（普通重连、保存设置后重连、切预设）都不启动新代理，提示用户先结束它。`stopBackends()` 每次都会再试着结束这些进程，仍没确认退出的继续记着，当前代理的 `stop()` 返回 `false` 时也一并记下；应用退出时同样再试一次。
- **收尾状态（`stopReason`，缺省按 `end_turn` 处理）**：

  | 结束方式 | 本轮状态 |
  |---|---|
  | 已点停止，或 `stopReason = cancelled` | `cancelled` |
  | `end_turn`（规划轮） | 有计划 → `planned`；没有 → `failed` |
  | `end_turn`（执行轮） | 视觉任务（带圈选截图发出）拍到改后截图 → `needs_review`，改了文件却没截图 → `unverified`；其余 → `completed` |
  | `refusal` / `max_tokens` / `max_turn_requests` / 其他原因 | `failed` 并说明原因；已收到的回复与工具结果保留，规划轮不给「确认并执行」 |
  | `session/prompt` 请求报错（非停止） | `failed` |
  | 宽限期超时被放弃 | `cancelled`（附说明） |
  | 代理进程意外退出 | `interrupted`（已收到的回复保留） |

  `session/prompt` 返回、请求报错、超时放弃、进程意外退出这四条路径，都先等结果图写盘、结算本轮改动快照，**把最终记录写入磁盘之后**才放开下一轮（请求报错、进程退出时代理也可能已经改过文件）；面板第一次看到空闲状态时，磁盘上已经是这一轮的最终记录。Fuxi 内核意外断开时同样把已显示的回复并入正文、先结算落盘再放开。

  `session/prompt` 返回（或报错）之后，这一轮由收尾路径认领（`acpFinishingRunId`）：收尾期间连接断了，断线处理不把它标成中断、也不替它放开任务，按代理给出的结果结束；点停止和宽限期超时放弃也不再插手。这样旧轮收尾时不可能清掉已经开始的新一轮的状态。没收到完成事件的工具保持「未完成」，不按成功计。
