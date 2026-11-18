import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentService, canvasPrompt, reviewContext } from '../src/main/agent.ts'
import { mapAnnotationsToImage, planImageLineage, type LineageCanvasElement } from '../src/main/lineage.ts'
import { isMarker } from '../src/main/semantic.ts'
import { pickCompareImage, resolveVisualStatus, type AgentResultImage, type AgentWorkItem, type ImageRegionAnnotation } from '../src/shared/agent.ts'

const ann = (over: Partial<ImageRegionAnnotation> = {}): ImageRegionAnnotation => ({
  imageId: 'I1', imageRef: 'src_img', pixelBbox: { x: 20, y: 675, w: 242, h: 25 }, naturalSize: { w: 1280, h: 720 },
  kind: 'loop', annotatorId: 'S1', ...over
})
const page = (id: string, afterEdit = false, tool = 'browser_page'): AgentResultImage => ({
  id, mediaType: 'image/png', name: `${tool} 的图片`, meta: { naturalWidth: 1280, naturalHeight: 720, tool, ...(afterEdit ? { afterEdit: true } : {}) }
})

test('对照图挑选：优先改过文件之后的最后一张页面截图，画布自读图不算', () => {
  const run = { images: [page('a'), page('b', true), page('c', true), page('d', false, 'canvas_read')] }
  assert.equal(pickCompareImage(run)?.id, 'c')
  assert.equal(pickCompareImage({ images: [page('a'), page('b')] })?.id, 'b')
  assert.equal(pickCompareImage({ images: [page('x', true, 'canvas_read')] }), undefined)
})

test('视觉任务的收尾状态不信内核的 completed：有对照图就等用户看，没截图就提示缺证据', () => {
  const visual = { annotations: [ann()], sourceImageRef: 'src_img' }
  // 第 3 轮那种：改错了但内核报 completed
  assert.deepEqual(resolveVisualStatus({ ...visual, images: [page('after', true)], changedFiles: ['HUDOverlay.ts'] }, 'completed'), { status: 'needs_review', compareImageId: 'after' })
  // 前两轮那种：改对了却是 unverified
  assert.equal(resolveVisualStatus({ ...visual, images: [page('after', true)] }, 'unverified').status, 'needs_review')
  const noShot = resolveVisualStatus({ ...visual, images: [], changedFiles: ['a.ts'] }, 'completed')
  assert.equal(noShot.status, 'unverified')
  assert.match(noShot.warning ?? '', /没有拍改后的页面截图/)
  // 非视觉任务、失败或停止的轮次保持原状
  assert.deepEqual(resolveVisualStatus({ images: [page('p')] }, 'completed'), { status: 'completed' })
  assert.deepEqual(resolveVisualStatus({ ...visual, images: [page('p')] }, 'failed'), { status: 'failed' })
  assert.deepEqual(resolveVisualStatus({ ...visual, images: [page('p')] }, 'cancelled'), { status: 'cancelled' })
})

test('收尾事件等结果截图写完再处理：run_finished 紧跟 tool_done 也能挑到对照图并进入等你看一眼', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fd-review-race-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'agent'))
  const item: AgentWorkItem = {
    id: 'w', board: 'default', cwd: home, sessionId: 's', title: '改血条',
    runs: [{
      id: 'r', taskId: 't', mode: 'direct', status: 'running', goal: '血条大一点', startedAt: '2026-11-18', reply: '', draft: '',
      annotations: [ann()], sourceImageRef: 'src_img',
      tools: [
        { id: 'e1', name: 'edit_file', input: '{"path":"src/ui/HUDOverlay.ts"}', status: 'completed', result: 'ok' },
        { id: 'b1', name: 'browser_page', input: '{}', status: 'running' }
      ],
      approvals: []
    }]
  }
  await writeFile(join(home, 'agent', 'work-items.json'), JSON.stringify({ version: 1, items: [item] }))
  const service = new AgentService({ home, executable: () => '', mcpServers: {} })
  const send = (event: string, data: Record<string, unknown>) =>
    (service as unknown as { onEvent(e: unknown): void }).onEvent({ type: 'event', seq: 1, run_id: 'r', req: 1, event, data })
  // 读记录时运行中的轮次会被标成中断；这里模拟内核正在跑这一轮
  const live = service as unknown as { state: { busy: boolean; items: AgentWorkItem[] } }
  live.state.busy = true
  live.state.items[0].runs[0].status = 'running'
  const png = Buffer.alloc(32)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]).copy(png, 0)
  png.writeUInt32BE(1280, 16)
  png.writeUInt32BE(720, 20)
  send('tool_done', { id: 'b1', name: 'browser_page', is_error: false, content: '{}', image: { media_type: 'image/png', dimensions: [1280, 720], data: png.toString('base64') } })
  // 图片还在异步落盘，收尾事件同步到达
  send('run_finished', { outcome: { status: 'completed' } })
  send('done', {})
  assert.equal(service.snapshot().items[0].runs[0].status, 'running', '图片写完前不应结束本轮')
  assert.equal(service.snapshot().busy, true)
  const deadline = Date.now() + 5000
  while (service.snapshot().busy && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
  const run = service.snapshot().items[0].runs[0]
  assert.equal(service.snapshot().busy, false)
  assert.equal(run.status, 'needs_review')
  assert.equal(run.images?.length, 1)
  assert.equal(run.compareImageId, run.images?.[0].id)
  assert.equal(run.images?.[0].meta?.afterEdit, true)

  // 用户说没改对：状态、说明落盘，下一轮提示词带上说明
  await service.review('r', 'rejected', '血条压住了怪物眼睛')
  let saved = JSON.parse(await readFile(join(home, 'agent', 'work-items.json'), 'utf8')).items[0].runs[0]
  assert.equal(saved.status, 'rejected')
  assert.equal(saved.review.verdict, 'rejected')
  assert.equal(saved.review.note, '血条压住了怪物眼睛')
  const prompt = canvasPrompt('再调一下', 'default', { sceneJson: '{"elements":[]}', selectedIds: [], pngBase64: null }, saved)
  assert.match(prompt, /认为没改对。用户的说明：血条压住了怪物眼睛/)
  const visualPrompt = canvasPrompt('血条大一点', 'default', { selectedIds: [], pngBase64: null, sceneJson: JSON.stringify({ elements: [], files: {} }) })
  assert.doesNotMatch(visualPrompt, /不要把截图/, '没有圈选页面截图时不加视觉对照要求')
  await service.review('r', 'approved')
  saved = JSON.parse(await readFile(join(home, 'agent', 'work-items.json'), 'utf8')).items[0].runs[0]
  assert.equal(saved.status, 'completed')
  await assert.rejects(service.review('nope', 'approved'), /找不到这一轮任务/)
  await service.close()
})

test('提示词：优先用不需要确认的读文件工具；没有核对结论时不加上一轮说明', () => {
  const prompt = canvasPrompt('目标', 'default', { sceneJson: '{"elements":[]}', selectedIds: [], pngBase64: null })
  assert.match(prompt, /优先用 glob、grep、read_file/)
  assert.doesNotMatch(prompt, /上一轮的改动/)
  assert.deepEqual(reviewContext(undefined), [])
  assert.match(reviewContext({ status: 'completed', review: { verdict: 'approved', decidedAt: 'x' } })[0], /确认改对了/)
})

test('圈选投到改后截图：按原图像素比例换算，太小的点放大到可见，宽高比不同时标近似', () => {
  const box = { x: 1000, y: 100, w: 640, h: 360 }
  const [hp] = mapAnnotationsToImage([ann()], 'src_img', box, { w: 1280, h: 720 })
  // 血条高 25px 换算后只有 12.5，放大到最小 28 并保持中心
  assert.deepEqual(hp, { x: 1010, y: 430, w: 121, h: 28, label: '对照 #1' })
  const [dot] = mapAnnotationsToImage([ann({ pixelBbox: { x: 640, y: 360, w: 1, h: 1 } })], 'src_img', box, null)
  assert.equal(dot.w, 28)
  assert.equal(dot.h, 28)
  const [approx] = mapAnnotationsToImage([ann()], 'src_img', box, { w: 1280, h: 1000 })
  assert.match(approx.label, /^≈/)
  assert.equal(mapAnnotationsToImage([ann({ imageRef: 'other' })], 'src_img', box, null).length, 0)
})

test('演进链落位时把圈选一并投到新图上，没有父图时不生成对照框', () => {
  const source: LineageCanvasElement = {
    id: 'src_img', type: 'image', x: 0, y: 0, width: 960, height: 540,
    customData: { flyingdraws: { imageMeta: { naturalWidth: 1280, naturalHeight: 720 } } }
  }
  const image: AgentResultImage = { ...page('a'.repeat(64), true), meta: { naturalWidth: 1280, naturalHeight: 720, tool: 'browser_page', sourceImageRef: 'src_img', round: 1 } }
  const plan = planImageLineage({ elements: [source], image, size: { w: 640, h: 360 }, sourceImageRef: 'src_img', annotations: [ann()] })
  assert.equal(plan.parentId, 'src_img')
  assert.equal(plan.overlays.length, 1)
  assert.ok(plan.overlays[0].x >= plan.x && plan.overlays[0].x + plan.overlays[0].w <= plan.x + plan.w)
  const lonely = planImageLineage({ elements: [], image: { ...image, meta: { naturalWidth: 1280, naturalHeight: 720, tool: 'browser_page' } }, size: { w: 640, h: 360 }, annotations: [ann()] })
  assert.equal(lonely.overlays.length, 0)
  assert.equal(isMarker({ id: 'o', type: 'rectangle', x: 0, y: 0, width: 1, height: 1, customData: { flyingdraws: { role: 'compare-overlay' } } } as never), true)
})

test('只读命令自动放行：tool_auto_approved 不论先于还是晚于 tool_start 到达，都挂到对应的工具记录上', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fd-auto-approved-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'agent'))
  const item: AgentWorkItem = {
    id: 'w', board: 'default', cwd: home, sessionId: 's', title: '看目录',
    runs: [{ id: 'r', mode: 'direct', status: 'completed', goal: '看目录', startedAt: '2026-11-18', reply: '', draft: '', tools: [], approvals: [] }]
  }
  await writeFile(join(home, 'agent', 'work-items.json'), JSON.stringify({ version: 1, items: [item] }))
  const service = new AgentService({ home, executable: () => '', mcpServers: {} })
  const send = (event: string, data: Record<string, unknown>) =>
    (service as unknown as { onEvent(e: unknown): void }).onEvent({ type: 'event', seq: 1, run_id: 'r', req: 1, event, data })
  send('tool_auto_approved', { name: 'pwsh', id: 'early', auto_approved: 'readonly_shell' })
  send('tool_start', { id: 'early', name: 'pwsh', params_preview: 'git status' })
  send('tool_start', { id: 'late', name: 'pwsh', params_preview: 'Get-ChildItem' })
  send('tool_auto_approved', { name: 'pwsh', id: 'late', auto_approved: 'readonly_shell' })
  send('tool_start', { id: 'asked', name: 'pwsh', params_preview: 'npm run typecheck' })
  const tools = service.snapshot().items[0].runs[0].tools
  assert.deepEqual(tools.map(tool => [tool.id, tool.autoApproved ?? null]), [['early', 'readonly_shell'], ['late', 'readonly_shell'], ['asked', null]])
  await service.close()
})

test('YOLO 审批模式：选择会记住、重开应用后恢复，内核事件同步，非法取值拒绝', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fd-yolo-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'agent'))
  const service = new AgentService({ home, executable: () => { throw new Error('不应启动内核') }, mcpServers: {} })
  assert.equal(service.snapshot().approvalMode, 'auto-safe', '默认按风险询问')
  // 内核没连上时只记住，下次打开工作区时带给内核
  await service.setApprovalMode('full-access')
  assert.equal(service.snapshot().approvalMode, 'full-access')
  assert.deepEqual(JSON.parse(await readFile(join(home, 'agent', 'host-settings.json'), 'utf8')), { approvalMode: 'full-access' })
  await assert.rejects(service.setApprovalMode('yolo' as never), /审批模式无效/)
  await service.close()
  const reopened = new AgentService({ home, executable: () => { throw new Error('不应启动内核') }, mcpServers: {} })
  assert.equal(reopened.snapshot().approvalMode, 'full-access', '重开应用后恢复')
  ;(reopened as unknown as { onEvent(e: unknown): void }).onEvent({ type: 'event', seq: 1, req: 1, event: 'approval_mode_changed', data: { mode: 'auto-safe' } })
  assert.equal(reopened.snapshot().approvalMode, 'auto-safe')
  ;(reopened as unknown as { onEvent(e: unknown): void }).onEvent({ type: 'event', seq: 2, req: 1, event: 'approval_mode_changed', data: { mode: 'whatever' } })
  assert.equal(reopened.snapshot().approvalMode, 'auto-safe', '不认识的模式不采纳')
  await reopened.close()
  await writeFile(join(home, 'agent', 'host-settings.json'), '{坏掉的')
  const broken = new AgentService({ home, executable: () => { throw new Error('不应启动内核') }, mcpServers: {} })
  assert.equal(broken.snapshot().approvalMode, 'auto-safe', '设置损坏时回到默认')
  await broken.close()
})

test('提示词：开发服务器用普通 job，不设 keep_alive', () => {
  assert.match(canvasPrompt('目标', 'default', { sceneJson: '{"elements":[]}', selectedIds: [], pngBase64: null }), /不要设 keep_alive/)
})
