# 接手文档

> 新会话动手前先读这份，再按需看 [design.md](design.md)。
> 最后更新：2026-11-15，画板重命名/删除与收件箱持久化迭代后。

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
| 多画板新建与切换（M4 提前引入） | ✅ 页面右上角支持切换画板和「+ 新建画板」，MCP 新增 `canvas_list`、`canvas_open(board?, title?)` 及各读写工具可选 `board` 参数 | 见 git log / 待提交 |
| 画板重命名/删除与收件箱持久化 | ✅ 页面支持「重命名」「删除」（至少保留一块，非切换操作走 `syncBoards` 保留撤销栈）；MCP 新增 `canvas_rename`、`canvas_delete`；未取走的「发给 agent」收件箱随 `pending.json` 持久化并在重启后恢复 | 待提交 |

- 远程：GitHub 仓库 `jian-in/Freedom-draw`，本地 `master` 跟踪 `origin/master`。
- 项目名定为 **Flying draws**（原暂定名 Sketchlink），显示的名字和内部标识符都改了：数据目录 `~/.flyingdraws`、页面接口 `window.flyingdraws`、元素标记 `customData.flyingdraws`、画板元数据 `scene.flyingdraws`、环境变量 `FLYINGDRAWS_HOME` / `FLYINGDRAWS_DEBUG_PORT`、npm 包名和 MCP 服务名 `flying-draws`、样式前缀 `fd-` / `--fd-`。兼容旧数据靠两处：主进程启动时把 `~/.sketchlink` 整个改名成 `~/.flyingdraws`（`index.ts` 的 `migrateLegacyDirs()`，新目录已存在就不动）；读画板文件时 `boards.ts` 的 `upgradeLegacyScene()` 把旧名字下的元数据和作者标记挪到新名字下。代码里还出现 `sketchlink` 的只有这两处。发布前仍要查 GitHub / npm 重名。

## 怎么跑

```bash
npm install          # 会顺带下载 Electron（postinstall）并拷贝字体
npm run build        # 应用打包到 out/，桥接编译到 out/bridge/
npm run dev          # 开发模式启动画布
npm test             # 语义层单元测试（node --test，直接跑 .ts）
npm run typecheck
npm run inspect      # 打印 ~/.flyingdraws/boards/default.excalidraw 的结构
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
src/main/index.ts      主进程入口：窗口、多画板会话切换/重命名/删除/版本号、给页面的 RPC、本地服务的路由
src/main/boards.ts     画板标识校验、文件名映射、标题归一化/更新、回退画板选择、空画板模板与元数据解析（纯函数）
src/main/semantic.ts   语义层（纯函数，不依赖 Electron）：buildGraph() 出结构，summarize() 出中文描述
src/main/ops.ts        绘图指令 → 绘图计划（纯函数）：校验 ops、解析节点引用、定好每个新元素的 id、位置和大小
src/main/diff.ts       提议的底稿和改动对比（纯函数）：用户在提议上改了什么
src/main/daemon.ts     本地 HTTP 服务：127.0.0.1 随机端口 + token，信息写 ~/.flyingdraws/daemon.json
src/main/requests.ts   请求队列：agent 请求作画、用户发送/取消、长轮询等待、主动发送的收件箱（含重启恢复与批量清理）
src/preload/index.ts   页面能调用的全部接口（含画板新建/切换/重命名/删除/列表，以及可清理的监听器）
src/renderer/src/App.tsx  画布、右上角状态栏（画板下拉切换、「+」新建、「⋯」菜单里的重命名/立即保存/打开文件位置/删除、保存状态圆点）、请求横幅、"发给 agent"、响应主进程 RPC（snapshot / applyPlan / loadScene / syncBoards）
src/bridge/index.ts    MCP 桥接（stdio）：9 个工具，转发给本地服务；应用没开时自动拉起
test/                  单元测试（boards / diff / ops / requests / semantic）；test/fixtures/flow.excalidraw 是测试用画板
scripts/e2e.mjs        M1 端到端测试（注意其工具列表断言仍停在 M1 的 4 个工具）
scripts/e2e-draw.mjs   M2 + 多画板完整端到端测试
```

读的数据流：agent → 桥接（stdio MCP）→ 本地服务（HTTP）→ 主进程 →（RPC）→ 页面取快照 → 主进程算语义 → 原路返回。

写的数据流（`canvas_draw`）：主进程先取快照定版本号 → `planOps()` 出绘图计划 → 页面的 `applyPlan()` 用 Excalidraw 的 `convertToExcalidrawElements` 生成元素、打上作者标记、绑定箭头，再 `updateScene` → 主进程存盘升版本号。所有写入在主进程里排队，一次一批。

提议的数据流（`canvas_propose`）：和 `canvas_draw` 走同一个 `drawOps()`，只是元素打上 `layer: 'proposal'` 和提议编号，画成功后在请求队列里建一个 `kind: 'proposal'` 的请求。用户点按钮时，页面的 `resolveProposal()` 把这批元素改成正式内容或删掉，再走原有的"发送"通路，多带一个 `decision`。

用户改了什么（`src/main/diff.ts`，纯函数）：提议画上去时 `captureBaseline()` 记一份底稿，存在请求上；用户接受时 `diffProposal()` 拿当时的画布和底稿比，输出几句中文（改了文字、挪了位置、删了什么、自己加了什么），放在 `canvas_wait` 结果的 `changes` 里。挪动不到 24px、大小变化不到 25% 的不报。

待处理的请求和未取走的收件箱会存盘：每次请求或收件箱有增减就原子写 `~/.flyingdraws/pending.json`（v2 格式 `{ version: 2, boards: { [boardId]: waiting[] }, inbox?: { [boardId]: Submission[] } }`，兼容旧版 `{ board, requests }`），应用启动时按画板读回来——等待中请求的编号不变（`request_id` 重启后还能用、确认横幅会重新出现），用户之前"发给 agent"但尚未被取走的收件箱内容与等待条也会一并恢复，直到被 `canvas_read` 或不带 `request_id` 的 `canvas_wait` 取走后清空。提议对应的元素要是已经不在对应画板上了（比如用户手动删光了），这个提议就不恢复。

多画板状态管理（`src/main/boards.ts` + `src/main/index.ts`）：
- 每块画板对应 `~/.flyingdraws/boards/<id>.excalidraw`，标题（可选）保存在 `scene.flyingdraws.title`。当前激活的画板 ID 记在 `~/.flyingdraws/state.json`，重启后自动恢复；没有 `state.json` 时默认 `default`。
- 每个画板在主进程有独立的 `BoardSession`（`version`、`history`、`RequestHub`），`requestBoard` 映射记录 `request_id → boardId`，切画板不会把别的画板的待处理横幅串过来。
- 页面右上角提供画板下拉框切换、「+ 新建画板」、「重命名」和「删除」（仅剩最后一块画板时禁用删除）；切换或删除当前画板前会自动把当前场景落盘，页面通过 `resetScene()` + `addFiles()` + `updateScene()` + `history.clear()` 载入目标画板，避免跨画板撤销串台。
- 重命名会迁移 `.excalidraw` 文件、更新 `scene.flyingdraws.title`、迁移内存 `BoardSession` 与 `requestBoard` 映射，并通过 `syncBoards` RPC 同步页面标题/列表而不重置画布和撤销栈；删除会取消并清空该画板的请求和收件箱、删除磁盘文件，若删的是当前激活画板则优先回退到 `default`（否则选剩余第一块）。

多个请求同时等着时按先来后到一个一个问，横幅上写着后面还有几个；轮到一个提议时视野会移到它上面，并让开顶部的横幅。

冲突怎么判断（design.md 12.3）：主进程每给 agent 一份画板描述，就在对应画板的内存记录里记下那个版本的"编号 → 元素"对照表和每个元素的指纹（`history`）。agent 带着 `base_version` 来画时：
- 版本没变：直接执行。
- 版本变了：`rebaseOps()` 把指令里的旧编号换算成同一个元素现在的编号。引用的节点被删了 → 冲突；要改动或删除的元素指纹变了（被别人动过）→ 冲突；只是连线过去、旁边加字 → 照常执行。
- 查不到那个版本，或者没带 `base_version` 却引用了已有节点 → 冲突，让 agent 重新读。

界面样式（`styles.css`）：淡黄纸面 + 墨线描边的线稿风（1.5px 墨线、错开的实线代替柔和阴影、黄色主按钮），同一段里也覆盖了 Excalidraw 工具栏的颜色变量。画布默认背景是纸色 `#fffbe6`（`App.tsx` 的 `PAPER_COLOR`）：载入时只把仍是默认白底的画板换成纸色，用户自己选过背景色的不动。窗口没有系统标题栏和菜单栏（`titleBarStyle: 'hidden'` + `titleBarOverlay`）：顶上 36px 那条是页面自己画的 `.fd-titlebar`，和画布同色、可拖动窗口，右边留给系统的最小化/关闭按钮；按钮颜色由页面经 `window:theme` 通知主进程跟着深浅色换。高度和颜色在 `index.ts` 的 `TITLEBAR_*` 和 `styles.css` 的 `--fd-titlebar-h`、`--fd-paper` 两处，要一起改。自己的界面统一用 `--fd-*` 颜色变量，页面把 Excalidraw 当前的深浅色写到 `<html data-fd-theme>` 上，横幅、弹窗、菜单跟着切换。「⋯」菜单用 portal 挂在 body 上，免得被横幅盖住。端到端测试会输出界面截图 `out/e2e/ui-menu.png`（浅色）和 `ui-dark.png`（深色）。

外观约定：agent 画的东西一律蓝色（`#1971c2`）；还没确认的提议再加虚线和 55% 透明度；接受后变实线、不透明，仍是蓝色。用户在提议上改过的地方（拖动、改字、删掉一部分）接受时原样保留。

作者标记写在元素的 `customData.flyingdraws = { author: 'agent', layer: 'final' }`（提议是 `layer: 'proposal'`，另带 `proposal: 提议编号`）。已在 Excalidraw 0.18.1 里确认：`customData` 是所有元素都有的可选字段，新建、载入、导出时都原样保留。没有这个标记的元素都算用户画的。

## MCP 工具

| 工具 | 说明 |
|---|---|
| `canvas_open` | 打开并前置窗口；可选 `board` 和 `title`，`board` 不存在时自动创建空白画板并切换过去 |
| `canvas_list` | 列出 `~/.flyingdraws/boards/` 下的所有画板（含当前激活标记、标题、版本号、元素数） |
| `canvas_rename` | 重命名指定（或当前）画板，并可选设置/清空显示标题（`title: null` 清空），保留当前会话和撤销历史 |
| `canvas_delete` | 删除指定（或当前）画板及其 `.excalidraw` 文件（不能删最后一块）；若删除当前画板会自动切换到剩余画板 |
| `canvas_read` | 可选 `board`；`format: summary/graph`，`image: auto/always/never`；auto 只在有涂鸦、图片、线条时附图 |
| `canvas_request` | 可选 `board`；弹出请求横幅，立即返回 `request_id` |
| `canvas_wait` | 最多等 45 秒；带 `request_id` 等那个请求（自动路由到对应画板），不带就等当前或指定 `board` 上用户主动"发给 agent" |
| `canvas_propose` | 可选 `board`；参数同 `canvas_draw`，另加 `question`。画在提议层上并弹出确认横幅，立即返回 `request_id`；用 `canvas_wait` 等结果，`decision` 是 `accepted` 或 `rejected` |
| `canvas_draw` | 可选 `board`；`ops`（`add_node` / `add_edge` / `add_text`）整批生效或整批不生效。另有 `update_node` / `delete_node` / `update_edge` / `delete_edge`，只能用在 agent 自己画的、已在正式层上的元素上。`direction: right/down` 定排版方向。引用已有节点（N1 这类编号）时必须带 `base_version`；冲突时返回原因和当前画板 |

工具描述是英文（给各种 agent 用），返回的画板描述是中文。国际化还没做。

## 开发与本地调试提示

- MCP 服务 `flying-draws` 已用 `claude mcp add` 注册在 **/path/to/flying-draws 项目的 local scope**，命令 `node /path/to/flying-draws/out/bridge/index.js`（旧的 `sketchlink` 注册已删除）。只有在这个文件夹里新开的会话才有这几个工具，工具全名是 `mcp__flying-draws__canvas_*`。旧的 Electron 缓存目录 `%APPDATA%/sketchlink` 还留着，里面没有用户数据，可以手动删。
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
- 还没做：一个圈圈住一组手写时，不会说"圈住了那组手写"；多笔画成的箭头也会被当成一组涂鸦。

**排版现在怎么做的（M2-b）**
- 一批指令里没指定坐标的新节点交给 dagre（`@dagrejs/dagre` 3.1.3）排成一块，`direction` 是 `right`（默认）或 `down`。整块放在已有内容的下方；这一块连着已有节点时，横向对齐到那些节点的正下方。**已有元素一律不动。**
- 挂在新节点旁边的文字（`add_text` 带 `near`）会在排版时留出位置，不会压到别的节点。
- 相邻两层之间的连线画直线，跨层的连线用 dagre 给的拐点画成曲线。箭头起止点按矩形、椭圆、菱形各自的轮廓算。
- 节点编号（N1、N2……）按阅读顺序排，排版一变编号就可能变。测试和 agent 都要用 `canvas_draw` 返回的对照表（`open = N1`），不要假设顺序。

**M2-a、M2-b 留下的缺口**
- 连到已有节点的线走直线，不绕路，可能压到用户已有的文字或图形（端到端测试的截图里就有一条压到了文字）。
- 新的一块永远放在所有内容的最下方，不会找旁边的空位。画板内容多了以后新内容会离得很远，靠视野自动移过去。
- 没有"移动"指令，也不能改节点的形状。改字后不会重新排版：新文字比原来长时，连线上的字可能盖住箭头，节点只会长高不会变宽。
- 独立的文字（`add_text` 画的）没有编号，agent 改不了也删不了。
- 改动和删除不能放在 `canvas_propose` 里，也就是说 agent 没法"提议删掉某个东西"。
- 冲突判断靠主进程内存里的版本记录（最近 60 个版本）。应用重启后查不到旧版本，agent 引用已有节点会被要求重新读一次。
- "被动过"的判断偏严：元素的 `version` 或它上面文字的 `version` 变了就算。用户拖动一个节点时，连着它的箭头也会变，所以 agent 这时去改那条箭头上的字也会冲突。
- 用户正在画一笔时，页面最多等 8 秒，超时就报错让 agent 重试；还没有 12.4 节说的"agent 有内容要画"提示。
- 改动对比只在接受时做。拒绝时提议已经删掉，agent 只拿到附言。
- 改动对比按"提议画上去之后"算：两个提议同时挂着时，用户这期间自己加的东西会在两个提议的结果里都出现一次。
- 端到端测试里"用户改提议"是直接改画布数据模拟的，不是真的鼠标拖动。真拖动时连着的箭头会跟着走，模拟的不会（截图 `propose-edited.png` 里那条箭头悬空就是这个原因）。
- agent 画的一批可以用撤销去掉（`CaptureUpdateAction.IMMEDIATELY`），这一点只看了接口说明，没有实际按过撤销验证。

**M2 后面几步**（设计见 design.md 第 4.3、7、12 节）
- M2 的代码到这里做完了。下一步是在真实 agent 会话里走一遍主演示（画草图 → agent 读 → agent 提议 → 用户改一笔接受 → agent 知道改了哪里），再决定 M3 做什么

**其他待定**
- **画布没法主动叫醒 agent**（MCP 是 agent 来问工具）。用户点了"发给 agent"而 agent 没在等时，画只能放在收件箱里（现已持久化到 `pending.json`，重启不丢失），要用户在聊天里说一声。画布上现在会明说这一点：发送前提示"要在聊天里说一声"，发出后显示"已发出，agent 还没来取"，被取走时提示"agent 已经取走你的画"。`canvas_read` 和不带 `request_id` 的 `canvas_wait` 都会取走收件箱里的画和附言。想真正做到"发了就到"，得用 MCP 的资源订阅通知（design.md 第 7 节末尾），而且客户端要支持
- 桥接靠 `require('electron')` 找可执行文件，Electron 现在是 devDependency；做成可分发的 npm 包时要重新设计启动方式
- **多画板当前限制**：目前仍是单窗口渲染，agent 在 `canvas_read`/`draw`/`propose`/`request` 传入非当前 `board` 时会把窗口切换到该画板（且要求该画板已存在，新画板需先通过 `canvas_open` 或界面创建）；支持重命名与删除，但重命名非当前激活画板后窗口不会切过去
- **升级提示**：如果本机之前已经开着旧版 Flying draws 窗口，重新 `npm run build` 后需要重启一次画布应用窗口（或在宿主里重连 MCP），新加的工具和接口才会生效
- 摘要只有中文
