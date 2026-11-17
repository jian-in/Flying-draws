# Flying draws

以画布为工作空间的本地 Agent。你用草图、圈选和文字表达目标，内置 Fuxi 内核执行任务，把结果带回画布，继续圈改。也保留 MCP 接入外部 agent 的用法。

完整设计见 [docs/design.md](docs/design.md)。

## 内置 Agent

Electron + Excalidraw 承载画布，随应用分发的无界面 Rust/Fuxi 进程负责模型、工具、审批、预算和会话。无需安装 Claude Code 或 Codex。

从源码运行（先准备本机的 Fuxi 源码，见 [实施契约](docs/fuxi-host-plan.md)）：

```bash
npm run build:fuxi -- --source /你的路径/fuxi-code
npm run build
npm start
```

`build:fuxi` 默认使用本机 Cargo 缓存，不下载依赖；`--debug` 构建调试版，`--online` 显式允许 Cargo 下载缺少的依赖。也可用 `FLYINGDRAWS_FUXI_SOURCE` 指定源码。内核输出到 `resources/fuxi/`，运行时可用 `FLYINGDRAWS_FUXI_BIN` 指向自己的兼容内核。

打开标题栏的「内置 Agent」：

- 在「模型设置」填写服务地址、模型 ID 和密钥，支持 OpenAI 兼容、Anthropic Messages 和 Gemini；按模型实际能力开启图片输入。
- 需要操作已有文件时先选择工作目录。输入目标，默认先拟计划，确认后执行；也可直接开始任务。
- 有选区时发送选区结构和截图，没有选区时发送当前画板。模型未启用视觉时明确使用结构输入。
- 工具审批、停止、结果和下一轮修改都在面板中。工具返回的图片可预览并放回画布继续批注。
- Completed 后的修改在同一会话开启下一轮任务；中断任务由用户明确继续。应用重启不会自动执行，待确认的旧计划需要重新拟定。

配置与会话位于 `~/.flyingdraws/agent/`，与原 Fuxi 配置分开。密钥保存在本机配置文件，不进入画布任务记录；可填 `env:变量名` 使用环境凭据。后台作业和截图产物仍可能写进所选工作目录的 `.rivet/jobs` 和 `.rivet/artifacts`。

Windows 可用 `npm run package:desktop` 生成 `dist/Flying-draws-win32-x64/Flying draws.exe` 及其依赖目录。脚本使用已经安装的 Electron 和实际运行时依赖，不另下载打包器；分发时保留整个目录。已有同名输出时会停止，避免覆盖正在使用的包。

## 外部 MCP 画布

- Electron 窗口里嵌入 Excalidraw 画布（中文界面，字体从本地加载，断网可用），自动保存到 `~/.flyingdraws/boards/default.excalidraw`
- **语义层**：把画翻译成节点、连线（含方向和标签）、旁注文字（挂到最近的节点或连线上）、包含关系、手绘笔画（圈 / 直线 / 涂鸦）；有文字描述不了的内容时附画布截图
- **MCP 桥接**：`flying-draws-mcp` 通过 stdio 接入任意 agent，画布应用没开时自动拉起
- **工具**（完整参数见 [交接文档](docs/handoff.md)）：

| 工具 | 作用 |
|---|---|
| `canvas_open` | 打开画布窗口并带到前台 |
| `canvas_list` / `canvas_rename` / `canvas_delete` | 列出、重命名和删除画板 |
| `canvas_read` | 读取画布：文字描述，可选结构 JSON（`format: "graph"`）和截图（`image: auto / always / never`） |
| `canvas_request` | 请用户画点什么，画布上会出现提示横幅，立即返回 `request_id` |
| `canvas_wait` | 等用户点"发送"（每次最多 45 秒）；不带 `request_id` 时等用户主动"发给 agent" |
| `canvas_draw` | 新增、修改和删除画布元素，引用已有元素时带版本号 |
| `canvas_propose` | 提出可接受、拒绝或调整的画布修改 |
| `canvas_pass` | 在 agent 席位间递画笔 |

支持自动排版、多画板、多席位和提议 diff。自由画图与外部 MCP 用法独立保留。

## 接入 agent

先构建一次：

```bash
npm run build
```

Claude Code：

```bash
claude mcp add flyingdraws -- node /你的路径/out/bridge/index.js
```

其他支持 stdio MCP 的 agent（Codex、Cursor、Gemini CLI 等）同理：命令是 `node`，参数是 `out/bridge/index.js` 的绝对路径。

接好以后可以这样用：在画布上画个草图，对 agent 说"看看我画的"；或者让 agent 在说不清的时候主动请你画。

## 运行

需要 Node.js 20.19+ 或 22.12+。

```bash
npm install
npm run dev
```

`npm install` 会顺带下载 Electron 并拷贝字体。国内网络下载 Electron 慢的话，先设置镜像再装：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

其他命令：

| 命令 | 作用 |
|---|---|
| `npm run build` | 打包应用到 `out/`，并编译 MCP 桥接到 `out/bridge/` |
| `npm start` | 运行打包后的版本 |
| `npm test` | 语义层单元测试 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run inspect` | 查看画板文件的结构（可以在后面跟文件路径） |

## 目录

```
src/main/       主进程：窗口、画板读写、本地服务（daemon）、请求队列、语义层
src/preload/    暴露给页面的最小接口
src/renderer/   页面：Excalidraw 画布、状态栏、请求横幅
src/bridge/     MCP 桥接进程（flying-draws-mcp）
test/           语义层测试和测试用画板
scripts/        字体拷贝、画板检查脚本
docs/           设计文档
```

## 安全

本地画布服务只监听 `127.0.0.1`，端口和随机 token 写在 `~/.flyingdraws/daemon.json`；拒绝带 `Origin` 头的浏览器请求和 Host 不是 `127.0.0.1` 的请求。模型请求由内置 Fuxi 发往你配置的服务商，保存配置不会发送任务。任务操作沿 Fuxi 风险策略，MCP 工具需要审批；停止和审批与执行通道分开。

验证：`npm run typecheck`、`npm test`、`npm run build`；`npm run e2e:agent` 使用隔离目录、真实 Electron/Fuxi 与本机假供应商验证图片、审批、画布回填、计划执行和取消，不调用外部模型。指定 `FLYINGDRAWS_E2E_APP` 可检查已打包的程序。

## 致谢

画布渲染与交互底层基于 [Excalidraw](https://github.com/excalidraw/excalidraw)（MIT License）构建。

内置执行内核复用 Fuxi（MIT License）；内核构建脚本会同时复制其许可文件。

## 许可证

MIT
