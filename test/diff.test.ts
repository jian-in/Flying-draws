import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureBaseline, diffProposal, type DiffElement } from '../src/main/diff.ts'

const mark = { customData: { flyingdraws: { author: 'agent', layer: 'proposal', proposal: 'p1' } } }

// 提议：「查缓存」→「直接返回」，连线上标着「命中」，旁边一段文字；外加一个用户自己的节点「入口」
function scene(): DiffElement[] {
  return [
    { id: 'u1', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 },
    { id: 'u1t', type: 'text', x: 10, y: 10, width: 40, height: 20, text: '入口', containerId: 'u1' },
    { id: 'a', type: 'diamond', x: 0, y: 200, width: 200, height: 100, ...mark },
    { id: 'at', type: 'text', x: 60, y: 240, width: 60, height: 20, text: '查缓存', containerId: 'a', ...mark },
    { id: 'b', type: 'rectangle', x: 400, y: 220, width: 120, height: 60, ...mark },
    { id: 'bt', type: 'text', x: 420, y: 240, width: 80, height: 20, text: '直接返回', containerId: 'b', ...mark },
    { id: 'e', type: 'arrow', x: 208, y: 250, width: 184, height: 0, startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' }, ...mark },
    { id: 'et', type: 'text', x: 280, y: 240, width: 40, height: 20, text: '命中', containerId: 'e', ...mark },
    { id: 'n', type: 'text', x: 0, y: 320, width: 120, height: 20, text: '只缓存五分钟', containerId: null, ...mark }
  ]
}
const edit = (els: DiffElement[], id: string, patch: Partial<DiffElement>) => els.map((el) => (el.id === id ? { ...el, ...patch } : el))
const drop = (els: DiffElement[], ...ids: string[]) => els.map((el) => (ids.includes(el.id) ? { ...el, isDeleted: true } : el))
const baseline = () => captureBaseline(scene(), 'p1')

test('底稿只记提议里的东西，绑在节点上的文字算节点的标签', () => {
  const b = baseline()
  assert.deepEqual(
    b.items.map((i) => [i.kind, i.label]),
    [
      ['node', '查缓存'],
      ['node', '直接返回'],
      ['edge', '命中'],
      ['text', '只缓存五分钟']
    ]
  )
  assert.equal(b.elementIds.length, 9)
})

test('什么都没改：没有改动', () => {
  assert.deepEqual(diffProposal(baseline(), scene()), [])
})

test('接受提议只是换了标记和样式，不算改动', () => {
  const accepted = scene().map((el) => (el.customData ? { ...el, customData: { flyingdraws: { author: 'agent', layer: 'final' } } } : el))
  assert.deepEqual(diffProposal(baseline(), accepted), [])
})

test('改节点的文字、挪位置', () => {
  let now = edit(scene(), 'at', { text: '查本地缓存' })
  now = edit(now, 'b', { x: 400, y: 420 })
  assert.deepEqual(diffProposal(baseline(), now), ['把节点「查缓存」的文字改成了「查本地缓存」', '把节点「直接返回」往下挪了'])
})

test('只挪了一点点不算移动', () => {
  assert.deepEqual(diffProposal(baseline(), edit(scene(), 'b', { x: 410, y: 225 })), [])
})

test('删掉节点时，连着它的线跟着断开，不重复报', () => {
  // Excalidraw 里删掉节点后，连线还在，但那一端的绑定没了
  let now = drop(scene(), 'b', 'bt')
  now = edit(now, 'e', { endBinding: null })
  assert.deepEqual(diffProposal(baseline(), now), ['删掉了节点「直接返回」'])
})

test('删连线、改连线上的文字、把连线接到别的节点', () => {
  assert.deepEqual(diffProposal(baseline(), drop(scene(), 'e', 'et')), ['删掉了连线 「查缓存」 → 「直接返回」'])
  assert.deepEqual(diffProposal(baseline(), edit(scene(), 'et', { text: '没过期' })), ['把连线 「查缓存」 → 「直接返回」 上的文字「命中」改成了「没过期」'])
  assert.deepEqual(diffProposal(baseline(), edit(scene(), 'e', { endBinding: { elementId: 'u1' } })), [
    '把连线 「查缓存」 → 「直接返回」 改成了 「查缓存」 → 「入口」'
  ])
})

test('改和删独立的文字', () => {
  assert.deepEqual(diffProposal(baseline(), edit(scene(), 'n', { text: '缓存十分钟' })), ['把文字「只缓存五分钟」改成了「缓存十分钟」'])
  assert.deepEqual(diffProposal(baseline(), drop(scene(), 'n')), ['删掉了文字「只缓存五分钟」'])
})

test('用户自己加的东西单独列出来，agent 后来画的不算', () => {
  const now: DiffElement[] = [
    ...scene(),
    { id: 'x1', type: 'rectangle', x: 600, y: 200, width: 100, height: 60 },
    { id: 'x1t', type: 'text', x: 610, y: 210, width: 40, height: 20, text: '写缓存', containerId: 'x1' },
    { id: 'x2', type: 'arrow', x: 520, y: 250, width: 80, height: 0 },
    { id: 'x3', type: 'freedraw', x: 0, y: 500, width: 30, height: 30 },
    { id: 'x4', type: 'freedraw', x: 40, y: 500, width: 30, height: 30 },
    { id: 'x5', type: 'rectangle', x: 900, y: 0, width: 100, height: 60, customData: { flyingdraws: { author: 'agent', layer: 'final' } } }
  ]
  assert.deepEqual(diffProposal(baseline(), now), ['自己加了：节点「写缓存」、1 条连线、2 笔手绘'])
})
