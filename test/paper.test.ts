import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boardBackground, hasExactBackground, PAPER_COLOR, paperOr } from '../src/shared/paper.ts'

test('paperOr：纯白和没设背景色时用纸色，其余原样', () => {
  assert.equal(paperOr('#ffffff'), PAPER_COLOR)
  assert.equal(paperOr('#FFFFFF'), PAPER_COLOR)
  assert.equal(paperOr(undefined), PAPER_COLOR)
  assert.equal(paperOr(''), PAPER_COLOR)
  assert.equal(paperOr('#1e1e1e'), '#1e1e1e')
})

test('boardBackground：带 exactBackground 的画板原样恢复，用户选的纯白也留得住', () => {
  const meta = { version: 3, exactBackground: true }
  assert.equal(boardBackground('#ffffff', meta), '#ffffff')
  assert.equal(boardBackground('#1e1e1e', meta), '#1e1e1e')
  assert.equal(boardBackground(PAPER_COLOR, meta), PAPER_COLOR)
  // 标记在、背景色缺失或写坏了，还是用纸色
  assert.equal(boardBackground(undefined, meta), PAPER_COLOR)
  assert.equal(boardBackground('', meta), PAPER_COLOR)
  assert.equal(boardBackground(42, meta), PAPER_COLOR)
})

test('boardBackground：老画板（没有标记）里的纯白当成默认白，换成纸色', () => {
  assert.equal(boardBackground('#ffffff', { version: 3 }), PAPER_COLOR)
  assert.equal(boardBackground('#ffffff', undefined), PAPER_COLOR)
  assert.equal(boardBackground('#ffffff', { exactBackground: 'yes' }), PAPER_COLOR)
  assert.equal(boardBackground('#a5d8ff', { version: 3 }), '#a5d8ff')
  assert.equal(hasExactBackground(null), false)
  assert.equal(hasExactBackground({ exactBackground: true }), true)
})
