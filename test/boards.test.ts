import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join, resolve } from 'node:path'
import {
  boardFilePath,
  emptyBoardScene,
  isValidBoardId,
  normalizeBoardId,
  normalizeBoardTitle,
  parseBoardMeta,
  pickFallbackBoard,
  suggestBoardId,
  updateBoardSceneTitle,
  validateBoardId
} from '../src/main/boards.ts'

test('validateBoardId 接受正常中英文编号，拒绝空串、空白与路径穿越', () => {
  assert.equal(validateBoardId('default'), 'default')
  assert.equal(validateBoardId('login-flow_2'), 'login-flow_2')
  assert.equal(validateBoardId('登录流程'), '登录流程')

  for (const bad of ['', '   ', '.', '..', '.hidden', 'a.', '../x', 'a/b', 'a\\b', 'a:b', 'a b', 'x'.repeat(65)]) {
    assert.equal(isValidBoardId(bad), false, `should reject ${JSON.stringify(bad)}`)
    assert.throws(() => validateBoardId(bad))
  }
})

test('normalizeBoardId 把中间空白折叠成连字符', () => {
  assert.equal(normalizeBoardId('  login   flow  '), 'login-flow')
  assert.equal(normalizeBoardId('登录 流程'), '登录-流程')
  assert.throws(() => normalizeBoardId('   '))
  assert.throws(() => normalizeBoardId('../escape'))
})

test('boardFilePath 始终落在 boardsDir 内部', () => {
  const dir = resolve('tmp-boards')
  assert.equal(boardFilePath(dir, 'default'), join(dir, 'default.excalidraw'))
  assert.throws(() => boardFilePath(dir, '../secret'))
})

test('emptyBoardScene 生成标准 Excalidraw 场景并保留可选标题', () => {
  const plain = emptyBoardScene()
  assert.equal(plain.type, 'excalidraw')
  assert.deepEqual(plain.elements, [])
  assert.deepEqual(plain.flyingdraws, { version: 1 })

  const titled = emptyBoardScene({ title: '  登录流程  ' })
  assert.deepEqual(titled.flyingdraws, { version: 1, title: '登录流程' })
})

test('parseBoardMeta 统计未删除元素、版本号和标题', () => {
  const json = JSON.stringify({
    elements: [{ id: '1', isDeleted: false }, { id: '2', isDeleted: true }, { id: '3' }],
    flyingdraws: { version: 7, title: '主流程' }
  })
  assert.deepEqual(parseBoardMeta('flow', json, '2026-11-15T12:00:00.000Z'), {
    board: 'flow',
    title: '主流程',
    version: 7,
    elements: 2,
    updatedAt: '2026-11-15T12:00:00.000Z'
  })

  // 损坏 JSON 降级返回默认值，不抛异常
  assert.deepEqual(parseBoardMeta('broken', '{bad', '2026-11-15T12:00:00.000Z'), {
    board: 'broken',
    title: null,
    version: 1,
    elements: 0,
    updatedAt: '2026-11-15T12:00:00.000Z'
  })
})

test('suggestBoardId 按序跳过已有编号', () => {
  assert.equal(suggestBoardId(['default']), 'board-1')
  assert.equal(suggestBoardId(['default', 'board-1', 'board-2']), 'board-3')
})

test('normalizeBoardTitle 裁剪空白并过滤空标题', () => {
  assert.equal(normalizeBoardTitle('  登录流程  '), '登录流程')
  assert.equal(normalizeBoardTitle('   '), null)
  assert.equal(normalizeBoardTitle(null), null)
  assert.equal(normalizeBoardTitle(123), null)
})

test('updateBoardSceneTitle 更新并可清空画板标题且保留版本号与元素', () => {
  const initial = JSON.stringify({
    type: 'excalidraw',
    elements: [{ id: 'e1' }],
    flyingdraws: { version: 5, title: '旧标题', custom: 'keep' }
  })
  const renamed = JSON.parse(updateBoardSceneTitle(initial, '  新标题  ')) as {
    elements: unknown[]
    flyingdraws: Record<string, unknown>
  }
  assert.equal(renamed.elements.length, 1)
  assert.deepEqual(renamed.flyingdraws, { version: 5, custom: 'keep', title: '新标题' })

  const cleared = JSON.parse(updateBoardSceneTitle(JSON.stringify(renamed), null)) as {
    flyingdraws: Record<string, unknown>
  }
  assert.deepEqual(cleared.flyingdraws, { version: 5, custom: 'keep' })
})

test('pickFallbackBoard 优先回退到 default，否则选第一块剩余画板', () => {
  assert.equal(pickFallbackBoard([{ board: 'a' }, { board: 'default' }]), 'default')
  assert.equal(pickFallbackBoard([{ board: 'a' }, { board: 'b' }]), 'a')
  assert.equal(pickFallbackBoard([]), null)
})
