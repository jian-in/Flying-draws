# Flying draws

**给编码 Agent 用的本地视觉演进画板与双向提议草稿纸**  
*Spatial memory, visual diff & live proposal pad for coding agents*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.19-339933.svg)](package.json)
[![MCP Tools](https://img.shields.io/badge/MCP-10%20Tools-1971c2.svg)](#10-个-mcp-画布工具)

**Flying draws** 不是又一个通用白板，也不是把 Mermaid 单向吐到屏幕上的静态画图插件。它是贴在你 IDE / 终端旁边的**本地空间记忆层与双向对齐草稿纸**（Electron + Excalidraw 离线中文字体）：你可以直接连入 **Claude Code、Codex、Cursor、Antigravity** 等任意 MCP 客户端，也可以开启内置 **Fuxi** 执行内核当作一体化视觉工作台。

---

## 为什么编码 Agent 需要一块「活」画布？

| 痛点维度 | 纯画图 MCP（单向吐图） | 浏览器一次性 DOM 点选 | **Flying draws** |
|---|---|---|---|
| **多轮修改上下文** | 每次重画覆盖，无历史对比 | 改完刷新即忘，看不见演进脉络 | **`v1 → v2 → v3` 视觉演进墙**，自动串联每轮渲染图与改动文件 |
| **人类纠偏方式** | 只能回到聊天框打字重说 | 只能重选重描述 | **提议层直接拖拽、改字、删单处红框**，手改差异自动编译成自然语言 Diff 回流 |
| **截图批注精度** | 缩放后坐标失真，模型瞎猜位置 | 仅限活 DOM，不支持设计稿/白板照 | **像素级逆映射**（兼容缩放/裁剪/翻转）+ **`trace_image` 照图还原可编辑矢量** |
| **多 Agent 协作** | 单会话独占 | 无空间共享 | **Win32 物理像素伴随吸附** + **6 色具名席位与 `canvas_pass` 递画笔接力** |

### 三大不可替代场景

1. **多轮视觉演进墙（Visual Evolution Wall）**  
   把网页截图或设计稿拖进画布，用红圈圈出问题、写一句批注——语义层自动将缩放、裁剪（`crop`）甚至翻转（`scale`）后的画布圈选**逆映射回原图真实像素坐标**，告别多模态模型瞎猜位置；Agent 改完源码重新渲染后，新版页面图自动落位在旧图右侧，并用标有本轮改动文件摘要（如 `第 2 轮 · App.tsx, styles.css`）的连线串成 `v1 → v2 → v3` 演进链（同时严格隔离 `canvas_read` 自拍截图，杜绝画中画递归）。

2. **照图活化 + 提议层手改 Diff 回流（`trace_image` + Proposal Diff）**  
   拍一张白板草图或粘贴架构截图，通过 `trace_image` 一键还原为保留原图十六进制配色的可编辑方框、文字与绑定连线，并以 **55% 半透明虚线提议**呈现；待改删的旧元素则以虚线标记框预览（删除框为 `#e03131` 红色）。无需打字解释——你直接在提议上**拖拽位置、双击改字、按 `Delete` 删掉不想要的单处红色删除框**，再点「**对，就这样**」，画布自动去噪并将你的手改行为编译成中文自然语言 Diff 回传给 Agent。

3. **Win32 物理像素伴随吸附 + 多 Agent 席位递画笔（Side-by-Side Dock + Multi-Seat Baton）**  
   把画布窗口往 VS Code、终端或浏览器侧边一靠松手，基于 `DWMWA_EXTENDED_FRAME_BOUNDS` 跨 DPI 校准实现零缝隙物理像素贴合，随目标窗口移动、缩放与置顶。Claude Code、Codex 与内置 Fuxi 各自拥有独立高对比配色席位与底部筛选标签，支持通过 `canvas_pass` 在不同编码 Agent 之间接力递交画笔与画板快照。

---

## 30 秒零门槛接入（免编译 Rust 内核）

接入外部编码 Agent **不需要**任何私有 Rust 源码，只需 Node.js `>= 20.19`（或 `22.12+`）即可启用全部 10 个 MCP 画布工具：

### 1. 安装并构建画布与桥接器

```bash
npm install
npm run build
```

> 国内网络下载 Electron 较慢时，可指定镜像加速安装：
> ```bash
> ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
> ```

### 2. 一键生成客户端配置与自检

运行内置向导输出你所用客户端（Claude Code / Cursor / Codex / Antigravity）的现成接入命令或 JSON 配置（自动填入本机绝对路径）：

```bash
# 查看全部主流客户端的一键接入命令
node out/bridge/index.js setup

# 或只输出指定客户端（支持 claude | cursor | codex | antigravity）
node out/bridge/index.js setup claude

# 自检 Node 版本、构建产物、桌面端可执行文件寻址与本地服务状态
node out/bridge/index.js doctor
```

例如在 Claude Code 中一行完成注册：

```bash
claude mcp add flying-draws -- node /你的绝对路径/out/bridge/index.js
```

> 全局链接（`npm link`）或通过包管理器安装后，也可直接使用 `flying-draws setup`、`flying-draws doctor` 与 `flying-draws-mcp`。

### 3. 开箱试玩示例画板

连接后无需手动先开桌面端——当 Agent 首次调用 `canvas_open` 或 `canvas_read` 时，桥接进程会自动拉起 Flying draws 桌面窗口。

仓库自带了一份可直接体验的网关与核心服务草图 [`examples/architecture-sketch.excalidraw`](examples/architecture-sketch.excalidraw)：

```bash
# 在终端预览该画板的节点、连线与手绘结构
node scripts/inspect.mjs examples/architecture-sketch.excalidraw
```

把它复制到 `~/.flyingdraws/boards/arch.excalidraw`，对你的 Agent 说：
> *「用 `canvas_read` 看看 `arch` 画板上我红圈圈住的地方，然后用 `canvas_propose` 帮我把双 Token 刷新流程补上。」*

Agent 读到的不是杂乱的坐标 JSON，而是高信噪比的空间语义描述：

```text
画板「arch」v1：5 个节点，4 条连线，3 段文字，1 笔手绘
节点：
  N1 「API 网关」矩形
  N2 「JWT 鉴权」菱形
  N3 「订单核心服务」矩形
  N4 「PostgreSQL 主库」矩形
  N5 「Redis 会话库」椭圆
连线：
  N1「API 网关」 → N2「JWT 鉴权」，标着「HTTPS」
  N2「JWT 鉴权」 ↔ N5「Redis 会话库」，标着「吊销列表查询」
文字：
  T2 「这里补双 Token 无感续期！」（在 N2「JWT 鉴权」 上方）
手绘：
  S1 一个圈，圈住了 N2「JWT 鉴权」，在 N1「API 网关」 右侧
```

### 纯画布免依赖桌面打包（Windows）

无需内置 Fuxi 内核，即可利用已安装的 Electron 一键打出免配置的纯 MCP 桌面目录包 `dist/Flying-draws-win32-x64/Flying draws.exe`（也可通过环境变量 `FLYINGDRAWS_APP` 让桥接器指向任意位置的桌面包）：

```bash
npm run package:canvas
```

---

## 10 个 MCP 画布工具

桥接器（`src/bridge/index.ts`）通过纯洁 `stdio` 暴露以下 10 个工具，读写工具均支持 `board` 指定画板与 `as` 声明协作者席位：

| 工具名 | 作用说明 |
|---|---|
| `canvas_open` | 打开画布窗口并置顶；传入不存在的 `board` 时自动创建空白画板并切换 |
| `canvas_list` | 列出所有画板（含当前激活状态、显示标题、版本号 `v*`、元素数量；带 `readOnlyHint`） |
| `canvas_rename` | 重命名画板 ID 或修改/清空显示标题，完整保留当前会话与撤销栈 |
| `canvas_delete` | 删除指定画板及磁盘文件（保留最后一块画板，删当前画板时自动回退） |
| `canvas_read` | 读取空间语义描述（`N*` 节点、`T*` 文字、`S*` 手绘/分组、`I*` 图片及像素级批注），可选结构 `format: "graph"` 与按需截图 `image: auto/always/never`，顺带取走用户收件箱与递画笔交接 |
| `canvas_request` | 在画布顶部弹出提示横幅请用户作画，立即返回 `request_id` |
| `canvas_wait` | 长轮询（单次最多 45s）等待 `canvas_request` / `canvas_propose` 的用户响应，或等待用户主动「发给 agent」及其他席位的递画笔交接 |
| `canvas_pass` | 将当前画板快照与交接附言递给另一席位（`to`），目标正在 `canvas_wait` 时即时唤醒，否则挂起待取 |
| `canvas_propose` | 在半透明虚线提议层新增元素、用虚线标记框预览改删操作并附上确认问题；用户手改或局部删框接受后，经 `canvas_wait` 返回自然语言 `changes` |
| `canvas_draw` | 立即执行整批新增（`add_node` / `add_edge` / `add_text`）、照图还原（`trace_image`）及改删/改样式（`update_node` / `delete_node` / `update_edge` / `delete_edge` / `update_text` / `delete_text` / `delete_strokes` / `set_style`）；引用已有元素需带 `base_version` |

---

## 核心工程架构导览

想深入了解底层数据结构、并发算法与系统编程细节，请参阅 **[架构与核心工程设计白皮书 (`docs/architecture.md`)](docs/architecture.md)**：

1. **双向提议对齐协议（Proposal-Diff Protocol）**：`toProposalPlan` 破坏性操作延迟化预览框、`resolveProposal` 帧存活局部否决、以及 `diffProposal` 双阈值（`24px` 位移 / `25%` 缩放）去噪合成中文反馈。
2. **基于语义指纹的乐观并发控制（Semantic Rebase & Fingerprinting）**：60 版本滑动历史窗口、`rebaseOps` 阅读序漂移自动重编号、以及 `elementFingerprints` 拓扑签名豁免绑定箭头因拖动节点产生的派生 `version` 伪冲突。
3. **混合空间语义层与像素逆映射（Spatial Semantic & Pixel Back-Projection）**：两阶段并查集手写分组与标注圈预判防吞并、零依赖 PNG/GIF/WebP/JPEG/SVG 二进制头解析、裁剪/翻转仿射逆映射（`canvasRectToImagePixels`）与 `lineage` 防递归演进排版。
4. **Win32 物理像素伴随吸附引擎（DWM Frame-Aligned Docking）**：`koffi` 直调 `user32`/`dwmapi`、`SetWinEventHook` 跨进程跟随、跨 DPI 显示器隐形阴影边（`DWMWA_EXTENDED_FRAME_BOUNDS`）二次校准与后台零开销休眠。
5. **双通道隔离与本地安全模型**：`127.0.0.1` + 禁 `Origin` + `Host` 校验防 DNS Rebinding + 常量时间随机 Token、单路径串行原子写，以及内置 Fuxi NDJSON 宿主进程双通道隔离。

想录制演示 GIF 或复现核心工作流，请参阅 **[演示录制分镜手册 (`docs/demo-playbook.md`)](docs/demo-playbook.md)**。

---

## 进阶：内置 Fuxi 独立 Agent 工作台

除了通过 MCP 接入外部 CLI，当你希望脱离外部终端、直接把画布当作**一体化本地视觉编码工作台**时，可以接入内置的无界面 Rust/Fuxi 执行内核：

1. **构建或指定 Fuxi 内核**（宿主契约见 [docs/fuxi-host-plan.md](docs/fuxi-host-plan.md)）：
   ```bash
   # 从本机 Fuxi 源码构建内核到 resources/fuxi/（默认离线使用 Cargo 缓存，--online 允许拉取依赖）
   npm run build:fuxi -- --source /你的路径/fuxi-code
   npm run build
   npm start
   ```
   也可直接通过环境变量 `FLYINGDRAWS_FUXI_BIN` 指向已有的兼容内核二进制文件；含内置内核的完整 Windows 打包使用 `npm run package:desktop`。

2. **面板工作流**：
   - 点击标题栏 **「内置 Agent」**，在「模型设置」填入服务地址、模型 ID 与密钥（支持 **OpenAI 兼容、Anthropic Messages、Gemini**；密钥仅存本机 `~/.flyingdraws/agent/config.toml` 或引用 `env:变量名`，不进画板记录）。
   - 选择目标项目目录：框选元素时仅发送选区与重叠底图（附像素级圈选坐标），未选择时发送当前画板；选中单张图片可直接点击 **「转成可编辑图 ↗」**。
   - 默认开启 **「自动把页面结果图连入画布演进链」**：工具产出的页面渲染图会自动接在上一版图片右侧生成演进箭头，也可随时点击 **「放到画布 ↗」** 幂等上墙，接着在最新结果图上开启第 2、第 3 轮圈改。

---

## 常用脚本与目录结构

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发模式热重载启动画布桌面端 |
| `npm run build` | 构建 Electron 应用到 `out/`，并编译 MCP 桥接到 `out/bridge/` |
| `npm run build:bridge` | 仅编译 MCP 桥接与 CLI（`out/bridge/index.js`） |
| `npm start` | 预览运行已构建的应用 |
| `npm run typecheck` | 全量 TypeScript 类型检查 |
| `npm test` | 运行语义层、排版、Diff、演进墙与 CLI 单元测试 |
| `npm run inspect` | 解析并打印 `.excalidraw` 画板结构（可跟文件路径，如 `node scripts/inspect.mjs examples/architecture-sketch.excalidraw`） |
| `npm run package:canvas` | 打包免 Fuxi 的纯 MCP 画布 Windows 独立目录包 |
| `npm run package:desktop` | 打包包含内置 Fuxi 内核的完整 Windows 独立目录包 |
| `npm run e2e:draw` | 拉起隔离实例（`FLYINGDRAWS_HOME`）运行多画板、绘制与提议端到端测试 |
| `npm run e2e:agent` | 使用隔离目录与本机假供应商验证内置 Agent 全链路（审批、演进回填、取消续接） |

```text
src/bridge/     MCP 桥接器与零门槛 CLI（setup / doctor / 自动寻址拉起）
src/main/       主进程：多画板会话、本地安全服务、空间语义层、排版与提议 Diff、演进墙、Win32 吸附、Fuxi 宿主客户端
src/preload/    ContextIsolation 最小白名单桥接接口
src/renderer/   Excalidraw 画布、请求/提议横幅、动态席位筛选栏、内置 Agent 面板
src/shared/     主进程与渲染层共享的 Agent 状态、血缘元数据与工具展示定义
examples/       开箱体验用的标准 Excalidraw 示例画板
docs/           架构白皮书（architecture.md）、录制手册（demo-playbook.md）、设计（design.md）与交接文档（handoff.md）
scripts/        字体本地化、画板检查、桌面免打包器构建与端到端测试脚本
test/           纯函数与 CLI 自动化测试集
```

---

## 安全与隐私说明

- **纯本地画布服务**：HTTP Daemon 仅监听 `127.0.0.1`，凭证写入本机 `~/.flyingdraws/daemon.json`（`0600`），严拒浏览器 `Origin` 请求与非 `127.0.0.1` 的 `Host` 头（防御 DNS Rebinding）。
- **数据流透明**：画板文件默认保存在本机 `~/.flyingdraws/boards/*.excalidraw`，字体完全本地化断网可用；仅当你通过外部 Agent 读取截图或在内置 Agent 中发起任务时，画布摘要/截图才会发往你所配置的模型服务商。

## 致谢与许可证

- 画布渲染与手绘交互基于 [Excalidraw](https://github.com/excalidraw/excalidraw)（MIT License）构建；随包第三方字体与运行时依赖声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 内置执行内核可选接入 Fuxi（MIT License）。
- 特别鸣谢首席驻场监工 **哈吉米**——在多轮并发压测、像素逆映射校准与深夜重构期间提供了稳定的呼噜声算力与精神监理（尽管当事人至今坚称自己只是顺路过来看看）。
- 本项目采用 [MIT License](LICENSE) 开源（Copyright (c) 2026 Bofei Jian）。
