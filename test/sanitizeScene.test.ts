import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasUnsafeCustomData, sanitizeElements, sanitizeLibraryItems, sanitizeScene } from '../src/shared/sanitizeScene.ts'
import { parseAndValidateLibraryJson } from '../src/main/library.ts'

const evilIframe = () => ({
  id: 'evil',
  type: 'iframe',
  customData: {
    keep: 1,
    flyingdraws: { author: 'user' },
    generationData: { status: 'done', html: '<script>alert(1)</script>' }
  }
})

test('sanitizeScene 剥掉 iframe 的 customData.generationData，保留其他 customData（CVE-2026-97224）', () => {
  const plain = { id: 'a', type: 'rectangle', customData: { flyingdraws: { author: 'agent' } } }
  const { scene, stripped } = sanitizeScene({ elements: [plain, evilIframe()], appState: { theme: 'dark' } })
  assert.equal(stripped, 1)
  assert.equal(scene.elements[0], plain)
  const cleaned = scene.elements[1] as ReturnType<typeof evilIframe>
  assert.equal('generationData' in cleaned.customData, false)
  assert.deepEqual(cleaned.customData, { keep: 1, flyingdraws: { author: 'user' } })
  assert.equal(hasUnsafeCustomData(cleaned), false)
  assert.deepEqual(scene.appState, { theme: 'dark' })
})

test('没有可疑字段时原样返回，不产生新对象', () => {
  const elements = [{ id: 'a', type: 'text' }, { id: 'b', type: 'iframe', customData: null }]
  const r = sanitizeElements(elements)
  assert.equal(r.stripped, 0)
  assert.equal(r.elements, elements)
  const scene = { elements }
  assert.equal(sanitizeScene(scene).scene, scene)
})

test('素材库 v1 / v2 条目都会被清洗，导入的 json 里不再含 html', () => {
  const v2 = sanitizeLibraryItems([{ id: 'i', elements: [evilIframe()] }])
  assert.equal(v2.stripped, 1)
  const v1 = sanitizeLibraryItems([[evilIframe()]])
  assert.equal(v1.stripped, 1)

  const raw = JSON.stringify({ type: 'excalidrawlib', version: 2, libraryItems: [{ id: 'i', elements: [evilIframe()] }] })
  const parsed = parseAndValidateLibraryJson(raw)
  assert.equal(parsed.itemCount, 1)
  assert.equal(parsed.json.includes('<script>'), false)
  assert.equal(parsed.json.includes('generationData'), false)

  const safe = JSON.stringify({ type: 'excalidrawlib', version: 2, libraryItems: [] })
  assert.equal(parseAndValidateLibraryJson(safe).json, safe)
})
