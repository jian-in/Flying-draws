# Flying draws

一块本地桌面画布，通过 MCP 接到任意 agent 上：你用画来表达想法，agent 能读懂画里的结构，也能把它的理解画回来让你确认。

完整设计见 [docs/design.md](docs/design.md)。

## 当前进度：M1「画给 agent 看」

- Electron 窗口里嵌入 Excalidraw 画布（中文界面，字体从本地加载，断网可用），自动保存到 `~/.flyingdraws/boards/default.excalidraw`
- **语义层**：把画翻译成节点、连线（含方向和标签）、旁注文字（挂到最近的节点或连线上）、包含关系、手绘笔画（圈 / 直线 / 涂鸦）；有文字描述不了的内容时附画布截图
- **MCP 桥接**：`flying-draws-mcp` 通过 stdio 接入任意 agent，画布应用没开时自动拉起
- **四个工具**：

| 工具 | 作用 |
|---|---|
| `canvas_open` | 打开画布窗口并带到前台 |
| `canvas_read` | 读取画布：文字描述，可选结构 JSON（`format: "graph"`）和截图（`image: auto / always / never`） |
| `canvas_request` | 请用户画点什么，画布上会出现提示横幅，立即返回 `request_id` |
| `canvas_wait` | 等用户点"发送"（每次最多 45 秒）；不带 `request_id` 时等用户主动"发给 agent" |

还没有：agent 往画布上画、提议层、嵌入块（见设计文档第 10 节里程碑）。

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

本地服务只监听 `127.0.0.1`，端口和随机 token 写在 `~/.flyingdraws/daemon.json`；拒绝带 `Origin` 头的浏览器请求和 Host 不是 `127.0.0.1` 的请求。应用里不内置任何模型，也不联网。

## 致谢

画布渲染与交互底层基于 [Excalidraw](https://github.com/excalidraw/excalidraw)（MIT License）构建。

## 许可证

MIT
