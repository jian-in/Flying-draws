# Flying draws 路线

> 2026-11-17，Claude 与 Codex 讨论后整理，维护者已拍板三项决定。下一轮动手前先看这里，再看 [handoff.md](handoff.md)。

## 定位

把画布当工作台的本地 Agent：画一笔、圈一下、写一句目标，内置的 Agent 动手，结果回到同一张画布，可以接着圈改。首个入口是“在已有前端仓库里圈改页面”，但不把产品永远限定成改网页的工具。

“本地内核 + 多轮圈改 + 外部 agent 也能接入”还不能算护城河：Cursor 已有在页面上点选、描述后改源码的能力，tldraw 有读写画布的 Agent 模板。要验证的产品假设是：**参考图、要求、每一版结果和改动证据都留在同一张画布上，下一轮不用重讲背景，所以人愿意在这里做第二、第三轮。**

## 已定（2026-11-17）

| 事项 | 决定 |
|---|---|
| 首批用户 | 开发者自用 |
| 真实验证的模型 | `deepseek-flash`（官方文档写明支持图片输入：JPEG/PNG/GIF/WebP，可传 base64；工具调用见各指南，以首轮实测为准） |
| 平台 | 先只做 Windows，保留通用内核 |

还没定：真实调用的费用上限（调用前必须有）；对外开放策略（不影响下面的许可核对）。

## 按完成条件推进

| 步骤 | 内容 | 完成条件 |
|---|---|---|
| ⓪ 并行，随时可做 | 根目录补 LICENSE（Flying draws `package.json` 与 Fuxi 都是 MIT，但根目录缺文件）；核对随包依赖、字体的许可与通知；查 GitHub/npm 重名；基础 README | — |
| ① 摸底（Claude 建议，先于 ②） | 用现在的版本手动跑一次：手动放页面截图、圈一下、让它改，花很少的预算 | 弄清模型最常错在哪，决定 ② 先修哪段 |
| ② 最小可用通路 | 结果截图绑定任务和结果版本，记原图尺寸、页面地址、视口；圈选按原图像素区域加批注保存，不把缩放后的画布坐标直接给模型；每轮回传新截图、改动文件和检查结果，能在新图上继续圈改。截图由 Fuxi 驱动浏览器打开真实运行页面来拍，应用只接收、关联、展示，不托管开发服务器——这条要先核实可行 | 只做最薄的一条 |
| ③ 真实验证 | 一个真实仓库、`deepseek-flash`，连续三轮真实修改 | 第一次可以告诉它仓库、启动命令和路由；之后除了提要求和审批，不靠人找代码、改代码或搬截图；每轮截图确属改后的页面，失败如实显示；记录耗时、费用、额外解释次数 |
| ④ 开发者自用 | release 内核、易用的分发包、首次配置顺手 | 维护者独立做完三轮，并且在自己的第二个真实任务上主动再用 |
| ⑤ 公开 | 公开 alpha，录演示，再找更多用户 | — |

哪一步没过就回头修那一步：③ 不过先修通路；③ 过了但不想再用，就重审场景。不拿多 Agent 协作或 Mac 版补救。

## 风险

- 截图陈旧或比例变化导致改错对象；改共享组件影响圈选以外的页面。
- 多轮背景越来越长，费用升高；不同服务商的视觉和工具能力不一致。
- 自带内核的维护成本挤占画布体验投入。
- 要讲清楚：执行在本地，但截图会发给远程模型。

## 已完成

- 后台常驻时等审批不再无声挂着：窗口不在前台（藏着、最小化或被挡住）时，托盘弹出「Fuxi 等你确认」，点击打开窗口；托盘悬停提示随状态显示“正在工作 / 等你确认”。（`src/main/agentNotice.ts`）
- 步骤 ⓪ 开源许可与打包合规：补齐根目录 `LICENSE`（MIT）与 `THIRD_PARTY_NOTICES.md`（覆盖随包运行时依赖、渲染层打包库及全部本地字体 OFL-1.1 / MIT / GPLv2 Font Exception 声明）；`scripts/package-desktop.mjs` 将 Electron 自带许可重命名为 `LICENSE.electron.txt` 并拷入项目自己的 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`。
- 步骤 ② 画布侧图像元数据与原图像素坐标换算：内置 Agent 保存结果图及放回画布时记录原图宽高、页面 URL / 源路径、视口与轮次（`ImageSourceMeta`），用户直接粘贴/拖入的图片由 `src/main/imageSize.ts` 零依赖解析头部像素宽高；`semantic.ts` 将落在图上的手绘圈选、矩形框选、箭头指向与文字/手写批注统一换算为原图像素区域（兼容缩放、裁剪 `crop` 与翻转 `scale`），选区发送时自动附带压在底下的原图，并在任务轮次记录结构化 `ImageRegionAnnotation`。
- 步骤 ② 多轮视觉演进墙闭环（2026-11-18）：新增 `src/main/lineage.ts`，记录本轮圈选源图 `sourceImageRef` 与改动文件短名摘要 `changedFiles`；`shouldAutoPlaceResultImage` 严格排除 `canvas_read` / `canvas_list` 画布自拍图避免死循环；页面/产物结果图默认自动（或点「放到画布 ↗」幂等）落位到父图右侧，同步生成带改动文件摘要的绑定箭头与顶部题注，串成 `v1 → v2 → v3` 横向演进链，并保持 `author: 'agent'` 作者筛选兼容。
- 步骤 ⓪ & ⑤ 开源零门槛接入、免内核打包与架构资产就绪（2026-11-18）：`out/bridge/index.js`（导出 `flying-draws` / `flying-draws-mcp`）新增 `setup [claude|cursor|codex|antigravity]`、`doctor`、`--help`、`--version` 子命令与多路径桌面端自动寻址（无参数保持纯净 MCP stdio）；新增免私有 Fuxi 源码的 `npm run package:canvas` 与 `.github/workflows/release.yml` 自动发布流水线；重写 `README.md` 首屏定位，并新增硬核工程设计文档 [docs/architecture.md](architecture.md)、15 秒 GIF 分镜手册 [docs/demo-playbook.md](demo-playbook.md) 与示例画板 `examples/architecture-sketch.excalidraw`。
