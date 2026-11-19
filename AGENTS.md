# Flying draws

给接手这个仓库的编码 Agent。先看这里，再按任务打开下面的文档。

Flying draws 是一块本地桌面画布（Electron + Excalidraw）：人在画布上圈选、写要求，内置 Agent 或外部 MCP Agent 读画、改项目，再把结果放回同一张画布。

## 常用命令

- `npm test`：全部单元测试。
- `npm run test:fast`：除 `roundBaseline.test.ts`、`cli.test.ts` 以外的单元测试。以后新增的 `test/*.test.ts` 会自动纳入，除非文件名正是这两个。
- `npm run typecheck`：类型检查。
- `npm run build`：构建到 `out/`，并编译 MCP 桥接。
- `npm run e2e:draw`：隔离实例里的画板、绘制和提议端到端测试。
- `npm run e2e:agent`：隔离实例加本机假模型的内置 Agent 端到端测试，不调用真实模型。
- `npm run package:desktop`：打 Windows 目录包。目标目录已存在时加 `-- --keep-old`，旧包按打包时间改名保留，新包先在临时目录打完再换到标准路径。

## 红线

- 会启动应用的测试或脚本必须设置 `FLYINGDRAWS_HOME`，把画板和 Electron 数据放到隔离目录。不要读、写或清空用户画板 `~/.flyingdraws`。
- 真实模型调用会花钱。调用前必须已经有维护者给出的费用上限。没有上限就不要发真实请求。
- 内核源码用 `--source` 或环境变量 `FLYINGDRAWS_FUXI_SOURCE` 指定。不要把某一台机器上的源码路径写进仓库。

## 文档地图

- `docs/architecture.md`：公开，随仓库分发。架构和核心机制看这份。
- `docs/roadmap.md`、`docs/handoff.md`、`docs/design.md`：被 gitignore，只在维护者本机。路线、接手说明和设计不在公开克隆里。

## 真实任务驱动

`node scripts/validate-real.mjs` 对隔离实例扮演用户。预算是按调用日志事后估算，超过才停，不是请求发出前的硬闸。用法写在脚本开头。
