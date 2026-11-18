import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentService, extractImageAnnotations, resolveSourceImageRef } from '../src/main/agent.ts'
import { buildGraph } from '../src/main/semantic.ts'
import {
  LINEAGE_GAP_X,
  LINEAGE_ROW_GAP_Y,
  extractChangedFiles,
  planImageLineage,
  shouldAutoPlaceResultImage,
  type LineageCanvasElement
} from '../src/main/lineage.ts'
import type { AgentResultImage, AgentTool } from '../src/shared/agent.ts'

function makeResultImage(id: string, overrides: Partial<AgentResultImage['meta']> = {}, tool = 'render_page'): AgentResultImage {
  return {
    id,
    mediaType: 'image/png',
    name: `${tool} 的图片`,
    meta: {
      naturalWidth: 1280,
      naturalHeight: 720,
      workItemId: 'work-1',
      round: 2,
      tool,
      ...overrides
    }
  }
}

test('v1 → v2 → v3 横向演进坐标、连线标签与版本题注生成', () => {
  const v1: LineageCanvasElement = {
    id: 'img_v1',
    type: 'image',
    x: 100,
    y: 120,
    width: 600,
    height: 360
  }

  const img2 = makeResultImage('a'.repeat(64), {
    workItemId: 'work-1',
    round: 2,
    sourceImageRef: 'img_v1',
    changedFiles: ['App.tsx', 'styles.css']
  })

  const verifiedPlan2 = planImageLineage({
    elements: [v1],
    image: img2,
    size: { w: 600, h: 360 },
    naturalSize: { w: 1280, h: 720 }
  })

  assert.equal(verifiedPlan2.alreadyPlaced, false)
  assert.equal(verifiedPlan2.parentId, 'img_v1')
  assert.equal(verifiedPlan2.x, 100 + 600 + LINEAGE_GAP_X)
  assert.equal(verifiedPlan2.y, 120)
  assert.equal(verifiedPlan2.versionNumber, 2)
  assert.ok(verifiedPlan2.edge)
  assert.equal(verifiedPlan2.edge.fromId, 'img_v1')
  assert.equal(verifiedPlan2.edge.toId, verifiedPlan2.imageId)
  assert.equal(verifiedPlan2.edge.label, '第 2 轮 · App.tsx, styles.css')
  assert.ok(verifiedPlan2.caption)
  assert.equal(verifiedPlan2.caption.text, 'v2 · 1280×720')
  assert.equal(verifiedPlan2.caption.x, verifiedPlan2.x)
  assert.ok(verifiedPlan2.caption.y < verifiedPlan2.y)

  const v2OnCanvas: LineageCanvasElement = {
    id: verifiedPlan2.imageId,
    type: 'image',
    x: verifiedPlan2.x,
    y: verifiedPlan2.y,
    width: verifiedPlan2.w,
    height: verifiedPlan2.h,
    customData: {
      flyingdraws: {
        author: 'agent',
        agent: 'Fuxi',
        seat: true,
        layer: 'final',
        result: img2.id,
        lineageVersion: verifiedPlan2.versionNumber,
        imageMeta: img2.meta
      }
    }
  }

  // 第 3 轮未显式圈选图片时，自动按同一 workItemId 下 round < 3 且最大的 v2 继续向右演进
  const img3 = makeResultImage('b'.repeat(64), {
    workItemId: 'work-1',
    round: 3,
    sourceImageRef: undefined,
    changedFiles: undefined
  })

  const plan3 = planImageLineage({
    elements: [v1, v2OnCanvas],
    image: img3,
    size: { w: 600, h: 360 },
    naturalSize: { w: 1280, h: 720 }
  })

  assert.equal(plan3.alreadyPlaced, false)
  assert.equal(plan3.parentId, verifiedPlan2.imageId)
  assert.equal(plan3.x, verifiedPlan2.x + 600 + LINEAGE_GAP_X)
  assert.equal(plan3.y, 120)
  assert.equal(plan3.versionNumber, 3)
  assert.ok(plan3.edge)
  assert.equal(plan3.edge.fromId, verifiedPlan2.imageId)
  assert.equal(plan3.edge.toId, plan3.imageId)
  assert.equal(plan3.edge.label, '第 3 轮结果')
  assert.equal(plan3.caption?.text, 'v3 · 1280×720')
})

test('幂等防重复插入：同一 image.id 已在画布上时不重复插入，删除后可重新放入且 ID 不冲突', () => {
  const img = makeResultImage('c'.repeat(64), { round: 2 })
  const placedId = `fd_img_${img.id.slice(0, 12)}`
  const liveImage: LineageCanvasElement = {
    id: placedId,
    type: 'image',
    x: 320,
    y: 180,
    width: 600,
    height: 360,
    customData: {
      flyingdraws: {
        author: 'agent',
        result: img.id,
        lineageVersion: 2,
        imageMeta: img.meta
      }
    }
  }

  const duplicate = planImageLineage({
    elements: [liveImage],
    image: img,
    size: { w: 600, h: 360 }
  })
  assert.equal(duplicate.alreadyPlaced, true)
  assert.equal(duplicate.existingElementId, placedId)
  assert.equal(duplicate.edge, null)
  assert.equal(duplicate.caption, null)

  // 用户删掉该结果图后，再次手动点击「放到画布」应允许重新放入，并避开历史已删除元素的 ID
  const deletedImage: LineageCanvasElement = { ...liveImage, isDeleted: true }
  const reinserted = planImageLineage({
    elements: [deletedImage],
    image: img,
    size: { w: 600, h: 360 },
    view: { x: 0, y: 0, w: 1200, h: 800 }
  })
  assert.equal(reinserted.alreadyPlaced, false)
  assert.notEqual(reinserted.imageId, placedId)
})

test('防画中画死循环：canvas_read 等画布自读工具严格排除在自动上墙之外', () => {
  const labels = {
    mcp_flying_draws_0: 'flying_draws/canvas_read',
    mcp_flying_draws_1: 'flying_draws/canvas_list',
    mcp_playwright_2: 'playwright/browser_take_screenshot'
  }

  assert.equal(shouldAutoPlaceResultImage(makeResultImage('1'.repeat(64), {}, 'render_page'), labels), true)
  assert.equal(shouldAutoPlaceResultImage(makeResultImage('2'.repeat(64), {}, 'browser_page'), labels), true)
  assert.equal(shouldAutoPlaceResultImage(makeResultImage('3'.repeat(64), {}, 'mcp_playwright_2'), labels), true)

  assert.equal(shouldAutoPlaceResultImage(makeResultImage('4'.repeat(64), {}, 'canvas_read'), labels), false)
  assert.equal(shouldAutoPlaceResultImage(makeResultImage('5'.repeat(64), {}, 'canvas_list'), labels), false)
  assert.equal(shouldAutoPlaceResultImage(makeResultImage('6'.repeat(64), {}, 'mcp_canvas_read'), labels), false)
  assert.equal(shouldAutoPlaceResultImage(makeResultImage('7'.repeat(64), {}, 'mcp_flying_draws_0'), labels), false)
  assert.equal(shouldAutoPlaceResultImage(makeResultImage('7'.repeat(64), {}, 'mcp_flying_draws_0')), false)
  assert.equal(shouldAutoPlaceResultImage(makeResultImage('8'.repeat(64), {}, 'flying_draws/canvas_read')), false)
  assert.equal(
    shouldAutoPlaceResultImage({ id: '9'.repeat(64), mediaType: 'image/png', name: '未知图片' }, labels),
    false
  )
})

test('改动文件名提取：去重提取短文件名、忽略失败工具并限制最多 4 个', () => {
  const tools: AgentTool[] = [
    { id: '1', name: 'read_file', input: '{"path":"src/renderer/src/Unchanged.tsx"}', status: 'completed' },
    { id: '2', name: 'edit_file', input: '{"path":"src/renderer/src/App.tsx","old_str":"const a = 1...', status: 'completed' },
    { id: '3', name: 'write_file', input: JSON.stringify({ file_path: 'D:\\workspace\\flying-draws\\src\\renderer\\src\\styles.css', content: 'body{}' }), status: 'completed' },
    { id: '4', name: 'edit_file', input: '{"path":"src/renderer/src/Broken.tsx"}', status: 'failed' },
    { id: '5', name: 'edit_file', input: '{"path":"src/renderer/src/App.tsx","old_str":"dup"}', status: 'completed' },
    {
      id: '6',
      name: 'apply_patch',
      input: '*** Begin Patch\n*** Update File: src/main/lineage.ts\n*** Add File: src/shared/agent.ts\n*** Update File: src/extra/fifth.ts\n*** End Patch',
      status: 'completed'
    }
  ]

  assert.deepEqual(extractChangedFiles(tools), ['App.tsx', 'styles.css', 'lineage.ts', 'agent.ts'])
})

test('避障右移与避障换行，且无父图落位忽略已删除远端元素（y < 10000）', () => {
  const v1: LineageCanvasElement = {
    id: 'img_v1',
    type: 'image',
    x: 0,
    y: 100,
    width: 600,
    height: 400
  }
  const baseX = 600 + LINEAGE_GAP_X // 760

  // 1) 右侧紧邻处有一个窄便签：同排向右避让即可落位
  const smallNote: LineageCanvasElement = {
    id: 'note_1',
    type: 'rectangle',
    x: baseX,
    y: 120,
    width: 100,
    height: 80
  }
  const stepRight = planImageLineage({
    elements: [v1, smallNote],
    image: makeResultImage('d'.repeat(64), { sourceImageRef: 'img_v1', round: 2 }),
    size: { w: 600, h: 400 }
  })
  assert.equal(stepRight.y, 100)
  assert.ok(stepRight.x > baseX + 100)

  // 2) 右侧首排已被另一张同尺寸分支图 v2a 占据：自动换行到下一行同列位置
  const branchV2a: LineageCanvasElement = {
    id: 'img_v2a',
    type: 'image',
    x: baseX,
    y: 100,
    width: 600,
    height: 400
  }
  const wrapped = planImageLineage({
    elements: [v1, branchV2a],
    image: makeResultImage('e'.repeat(64), { sourceImageRef: 'img_v1', round: 3 }),
    size: { w: 600, h: 400 }
  })
  assert.equal(wrapped.x, baseX)
  assert.equal(wrapped.y, 100 + 400 + LINEAGE_ROW_GAP_Y)

  // 3) 无父图时忽略 y=100000 的已删除元素，确保 y < 10000
  const farDeleted: LineageCanvasElement = {
    id: 'deleted-far',
    type: 'rectangle',
    x: 100000,
    y: 100000,
    width: 200,
    height: 120,
    isDeleted: true
  }
  const standalone = planImageLineage({
    elements: [farDeleted],
    image: makeResultImage('f'.repeat(64), { workItemId: 'other-work', round: 1 }),
    size: { w: 500, h: 320 },
    view: { x: 40, y: 60, w: 1200, h: 800 }
  })
  assert.ok(standalone.y < 10000)
  assert.equal(standalone.parentId, null)
  assert.equal(standalone.edge, null)
})

test('AgentService 记录 sourceImageRef 与 changedFiles 并写入结果图 ImageSourceMeta', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'fd-lineage-agent-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'agent'))

  const item = {
    id: 'work-ev',
    board: 'default',
    cwd: home,
    sessionId: 's1',
    title: '优化按钮样式',
    runs: [
      {
        id: 'run-ev',
        taskId: 't-ev',
        mode: 'execute',
        status: 'running',
        goal: '按批注修改按钮',
        startedAt: '2026-11-18T00:00:00.000Z',
        reply: '',
        draft: '',
        sourceImageRef: 'canvas-img-v1',
        tools: [],
        approvals: []
      }
    ]
  }
  await writeFile(join(home, 'agent', 'work-items.json'), JSON.stringify({ version: 1, items: [item] }))
  const service = new AgentService({ home, executable: () => '', mcpServers: {} })
  const send = (event: string, data: Record<string, unknown>) =>
    (service as unknown as { onEvent(e: unknown): void }).onEvent({
      type: 'event',
      seq: 1,
      run_id: 'run-ev',
      req: 1,
      event,
      data
    })

  send('tool_start', { id: 't1', name: 'edit_file', params_preview: '{"path":"src/renderer/src/App.tsx"}' })
  send('tool_done', { id: 't1', name: 'edit_file', is_error: false, content: 'ok' })
  send('tool_start', { id: 't2', name: 'write_file', params_preview: '{"path":"src/renderer/src/styles.css"}' })
  send('tool_done', { id: 't2', name: 'write_file', is_error: false, content: 'ok' })

  const png = Buffer.alloc(32)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]).copy(png, 0)
  png.writeUInt32BE(1280, 16)
  png.writeUInt32BE(720, 20)

  send('tool_start', { id: 't3', name: 'render_page', params_preview: '{"url":"http://127.0.0.1:5173"}' })
  send('tool_done', {
    id: 't3',
    name: 'render_page',
    is_error: false,
    content: JSON.stringify({ untrusted_page_observation: { url: 'http://127.0.0.1:5173/' }, source_path: 'index.html' }),
    image: { media_type: 'image/png', dimensions: [1280, 720], data: png.toString('base64') }
  })

  await service.close()
  const savedRun = JSON.parse(await readFile(join(home, 'agent', 'work-items.json'), 'utf8')).items[0].runs[0]
  assert.equal(savedRun.sourceImageRef, 'canvas-img-v1')
  assert.deepEqual(savedRun.changedFiles, ['App.tsx', 'styles.css'])
  assert.equal(savedRun.images.length, 1)
  assert.equal(savedRun.images[0].meta.tool, 'render_page')
  assert.equal(savedRun.images[0].meta.sourceImageRef, 'canvas-img-v1')
  assert.deepEqual(savedRun.images[0].meta.changedFiles, ['App.tsx', 'styles.css'])
  assert.equal(savedRun.images[0].meta.sourcePath, 'index.html')
  assert.equal(savedRun.images[0].meta.url, 'http://127.0.0.1:5173/')
})

test('resolveSourceImageRef 优先提取批注关联图片，无批注时回退到单选图片稳定 ID', () => {
  const graph = buildGraph([
    {
      id: 'img_base',
      type: 'image',
      x: 50,
      y: 50,
      width: 400,
      height: 300,
      customData: { flyingdraws: { imageMeta: { naturalWidth: 800, naturalHeight: 600 } } }
    },
    {
      id: 'box_ann',
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 80,
      height: 60
    }
  ])
  const annotations = extractImageAnnotations(graph)
  assert.equal(annotations.length, 1)
  assert.equal(resolveSourceImageRef(graph, annotations, ['box_ann']), 'img_base')

  const unannotatedGraph = buildGraph([
    { id: 'img_only', type: 'image', x: 10, y: 10, width: 300, height: 200 },
    { id: 'shape_other', type: 'rectangle', x: 500, y: 10, width: 100, height: 80 }
  ])
  assert.equal(resolveSourceImageRef(unannotatedGraph, [], ['img_only']), 'img_only')
  assert.equal(resolveSourceImageRef(unannotatedGraph, [], ['shape_other']), undefined)
})

