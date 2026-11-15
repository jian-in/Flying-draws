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
| M2「用画对话」 | 未开始 | — |

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

## 代码地图

```
src/main/index.ts      主进程入口：窗口、画板读写和版本号、给页面的 RPC、本地服务的路由
src/main/semantic.ts   语义层（纯函数，不依赖 Electron）：buildGraph() 出结构，summarize() 出中文描述
src/main/daemon.ts     本地 HTTP 服务：127.0.0.1 随机端口 + token，信息写 ~/.sketchlink/daemon.json
src/main/requests.ts   请求队列：agent 请求作画、用户发送/取消、长轮询等待、主动发送的收件箱
src/preload/index.ts   页面能调用的全部接口
src/renderer/src/App.tsx  画布、状态栏、请求横幅、"发给 agent"、响应主进程 RPC（snapshot 取场景和 PNG）
src/bridge/index.ts    MCP 桥接（stdio）：4 个工具，转发给本地服务；应用没开时自动拉起
test/semantic.test.ts  语义层测试；test/fixtures/flow.excalidraw 是测试用画板
scripts/e2e.mjs        端到端测试
```

数据流：agent → 桥接（stdio MCP）→ 本地服务（HTTP）→ 主进程 →（RPC）→ 页面取快照 → 主进程算语义 → 原路返回。

## MCP 工具

| 工具 | 说明 |
|---|---|
| `canvas_open` | 打开并前置窗口 |
| `canvas_read` | `format: summary/graph`，`image: auto/always/never`；auto 只在有涂鸦、图片、线条时附图 |
| `canvas_request` | 弹出请求横幅，立即返回 `request_id` |
| `canvas_wait` | 最多等 45 秒；带 `request_id` 等那个请求，不带就等用户主动"发给 agent" |

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

**M2「用画对话」**（设计见 design.md 第 4.3、7、12 节）
- `canvas_draw` / `canvas_propose`，参数是高层 ops（add_node、add_edge……），带 `base_version` 做乐观并发
- 提议层：agent 画的东西半透明另一种颜色，用户接受或修改后合并；元素来源写进 `customData`（要先在 Excalidraw 源码里确认这个字段的用法）
- 用户正在画一笔时，agent 的写入排队等待（12.4 节）
- 自动排版（ELK.js 或 dagre）

**其他待定**
- 请求队列只在内存里，应用重启后进行中的请求会丢（agent 会收到 unknown_request，提示它重新请求）
- 桥接靠 `require('electron')` 找可执行文件，Electron 现在是 devDependency；做成可分发的 npm 包时要重新设计启动方式
- 只有一块画板 `default`，多画板还没做
- 摘要只有中文
