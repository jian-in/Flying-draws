# Sketchlink（暂定名）

一块本地桌面画布，通过 MCP 接到任意 agent 上：你用画来表达想法，agent 能读懂画里的结构，也能把它的理解画回来让你确认。

完整设计见 [docs/design.md](docs/design.md)。

## 当前进度：M0 技术验证

- Electron 窗口里嵌入 Excalidraw 画布（中文界面，字体从本地加载，断网可用）
- 画布内容有变化时自动保存到 `~/.sketchlink/boards/m0.excalidraw`，重启后自动恢复
- `npm run inspect` 读取保存的画板，打印节点、连线、游离文字和手绘笔画，用来验证数据能支撑语义层

还没有：MCP 桥接、语义层、提议层（见设计文档第 10 节里程碑）。

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
| `npm run build` | 打包到 `out/` |
| `npm start` | 运行打包后的版本 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run inspect` | 查看画板文件的结构（可以在后面跟文件路径） |

## 目录

```
src/main/       主进程：窗口、读写画板文件
src/preload/    暴露给页面的最小接口（load / save / reveal）
src/renderer/   页面：Excalidraw 画布和状态栏
scripts/        字体拷贝、画板检查脚本
docs/           设计文档
```

## 许可证

MIT
