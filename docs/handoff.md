# 接手文档

> 新会话动手前先读这份，再按需看 [design.md](design.md)。
> 最后更新：2026-11-15，M1 完成后。

## 一句话

Sketchlink（暂定名）：本地桌面画布（Electron + Excalidraw），通过 MCP 接任意 agent。用户用画表达想法，agent 读到的是结构化的文字描述，认不出来的内容附截图。

## 现在在哪

| 里程碑 | 状态 | 提交 |
|---|---|---|
| M0 技术验证 | ✅ | `94a9fe9` |
| M1「画给 agent 看」 | ✅ 代码完成，单元测试和端到端测试通过；用户已在真实画布上手写字、经 MCP 读到并靠截图认出 | `6ee92fc` |
| M2-a 写入通路 | ✅ `canvas_draw` 纯新增（节点、连线、文字），单元测试和隔离画板上的端到端测试通过；还没在真实 agent 会话里用过 | 见 git log |
| M2-b 自动排版 | ✅ 新节点用 dagre 排版，可选从左到右或从上到下；箭头按图形轮廓起止，跨层连线会绕开节点。测试情况同上 | 见 git log |
| M2-c 提议层 | ✅ `canvas_propose`：agent 画的提议是蓝色虚线半透明，用户点接受或拒绝，结果经 `canvas_wait` 回到 agent。测试情况同上，端到端测试里用 DevTools 扮演用户点了按钮 | 见 git log |
| M2-d diff 和并发 | 未开始 | — |

- 远程：GitHub 仓库 `jian-in/Freedom-draw`，本地 `master` 跟踪 `origin/master`。
- 项目名还是暂定，发布前要查 GitHub / npm 重名。

## 怎么跑

```bash
npm install          # 会顺带下载 Electron（postinstall）并拷贝字体
npm run build        # 应用打包到 out/，桥接编译到 out/bridge/
npm run dev          # 开发模式启动画布
npm test             # 语义层单元测试（node --test，直接跑 .ts）
npm run typecheck
npm run inspect      # 打印 ~/.sketchlink/boards/default.excalidraw 的结构
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

它还会用 DevTools 端口 9334 在页面里点按钮，扮演用户接受和拒绝提议（隔离实例上设了 `SKETCHLINK_DEBUG_PORT` 才会开这个端口）。提议的截图在 `out/e2e/propose.png` 和 `propose-accepted.png`。

隔离靠环境变量 `SKETCHLINK_HOME`：设了它，画板、`daemon.json` 和 Electron 的 userData 都放到那个目录下，可以和用户开着的画布同时运行。**凡是会往画布上写东西的测试都要用它。**

## 代码地图

```
src/main/index.ts      主进程入口：窗口、画板读写和版本号、给页面的 RPC、本地服务的路由
src/main/semantic.ts   语义层（纯函数，不依赖 Electron）：buildGraph() 出结构，summarize() 出中文描述
src/main/ops.ts        绘图指令 → 绘图计划（纯函数）：校验 ops、解析节点引用、定好每个新元素的 id、位置和大小
src/main/daemon.ts     本地 HTTP 服务：127.0.0.1 随机端口 + token，信息写 ~/.sketchlink/daemon.json
src/main/requests.ts   请求队列：agent 请求作画、用户发送/取消、长轮询等待、主动发送的收件箱
src/preload/index.ts   页面能调用的全部接口
src/renderer/src/App.tsx  画布、状态栏、请求横幅、"发给 agent"、响应主进程 RPC（snapshot 取场景和 PNG）
src/bridge/index.ts    MCP 桥接（stdio）：4 个工具，转发给本地服务；应用没开时自动拉起
test/semantic.test.ts  语义层测试；test/fixtures/flow.excalidraw 是测试用画板
scripts/e2e.mjs        端到端测试
```

读的数据流：agent → 桥接（stdio MCP）→ 本地服务（HTTP）→ 主进程 →（RPC）→ 页面取快照 → 主进程算语义 → 原路返回。

写的数据流（`canvas_draw`）：主进程先取快照定版本号 → `planOps()` 出绘图计划 → 页面的 `applyPlan()` 用 Excalidraw 的 `convertToExcalidrawElements` 生成元素、打上作者标记、绑定箭头，再 `updateScene` → 主进程存盘升版本号。所有写入在主进程里排队，一次一批。

提议的数据流（`canvas_propose`）：和 `canvas_draw` 走同一个 `drawOps()`，只是元素打上 `layer: 'proposal'` 和提议编号，画成功后在请求队列里建一个 `kind: 'proposal'` 的请求。用户点按钮时，页面的 `resolveProposal()` 把这批元素改成正式内容或删掉，再走原有的"发送"通路，多带一个 `decision`。

外观约定：agent 画的东西一律蓝色（`#1971c2`）；还没确认的提议再加虚线和 55% 透明度；接受后变实线、不透明，仍是蓝色。用户在提议上改过的地方（拖动、改字、删掉一部分）接受时原样保留。

作者标记写在元素的 `customData.sketchlink = { author: 'agent', layer: 'final' }`（提议是 `layer: 'proposal'`，另带 `proposal: 提议编号`）。已在 Excalidraw 0.18.1 里确认：`customData` 是所有元素都有的可选字段，新建、载入、导出时都原样保留。没有这个标记的元素都算用户画的。

## MCP 工具

| 工具 | 说明 |
|---|---|
| `canvas_open` | 打开并前置窗口 |
| `canvas_read` | `format: summary/graph`，`image: auto/always/never`；auto 只在有涂鸦、图片、线条时附图 |
| `canvas_request` | 弹出请求横幅，立即返回 `request_id` |
| `canvas_wait` | 最多等 45 秒；带 `request_id` 等那个请求，不带就等用户主动"发给 agent" |
| `canvas_propose` | 参数同 `canvas_draw`，另加 `question`。画在提议层上并弹出确认横幅，立即返回 `request_id`；用 `canvas_wait` 等结果，`decision` 是 `accepted` 或 `rejected` |
| `canvas_draw` | `ops`（`add_node` / `add_edge` / `add_text`）整批生效或整批不生效；只能新增。`direction: right/down` 定排版方向。引用已有节点（N1 这类编号）时必须带 `base_version`，版本对不上返回冲突和当前画板 |

工具描述是英文（给各种 agent 用），返回的画板描述是中文。国际化还没做。

## 开发与本地调试提示

- `sketchlink` 已用 `claude mcp add` 注册在 **/path/to/flying-draws 项目的 local scope**，命令 `node /path/to/flying-draws/out/bridge/index.js`。只有在这个文件夹里新开的会话才有这几个工具。
- 用户的画板 `~/.sketchlink/boards/default.excalidraw` 里有**用户自己画的东西**（手写字、涂鸦），测试时只读，不要清空或覆盖。
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
- 只有三种新增指令。`move`、`update`、`delete` 这些要改动已有元素，得先有 M2-d 的冲突判断，而且 agent 只能动自己画的（design.md 12.4）。
- 冲突判断比 design.md 12.3 粗：只要引用了已有节点，`base_version` 就必须等于当前版本，不管那些节点有没有被动过。原因是 N1 这类编号按阅读顺序生成，画板一变就可能指向别的节点。要放宽得先给节点一个跨版本稳定的编号。
- 用户正在画一笔时，页面最多等 8 秒，超时就报错让 agent 重试；还没有 12.4 节说的"agent 有内容要画"提示。
- **提议没处理完就重启应用**：请求队列只在内存里，重启后横幅没了，但蓝色虚线的元素还留在画布上，没有按钮可以接受或拒绝（用户可以手动删）。要解决得把待处理的提议存盘，或者启动时把残留的提议层元素清掉。
- 用户接受提议时，agent 只知道"接受了"和接受后的整张画，不知道用户具体改了哪几处。这就是 M2-d 要做的 diff。
- 同时有多个待处理的请求时，横幅只显示最早的那个。
- agent 画的一批可以用撤销去掉（`CaptureUpdateAction.IMMEDIATELY`），这一点只看了接口说明，没有实际按过撤销验证。

**M2 后面几步**（设计见 design.md 第 4.3、7、12 节）
- M2-d：用户修改提议后的 diff，按元素判断冲突

**其他待定**
- 请求队列只在内存里，应用重启后进行中的请求会丢（agent 会收到 unknown_request，提示它重新请求）
- 桥接靠 `require('electron')` 找可执行文件，Electron 现在是 devDependency；做成可分发的 npm 包时要重新设计启动方式
- 只有一块画板 `default`，多画板还没做
- 摘要只有中文
