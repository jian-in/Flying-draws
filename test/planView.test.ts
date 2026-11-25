import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planBody, planDisplay } from '../src/renderer/src/planView.ts'

test('计划框：ACP 显示结构化步骤，回复不同时另作补充说明', () => {
  const steps = '- [ ] 读画布\n- [ ] 改 a.txt'
  assert.deepEqual(planDisplay({ plan: steps, reply: '先读画布再改文件。' }, true), { body: steps, note: '先读画布再改文件。' })
  // 代理只回了文字、没发结构化步骤：计划就是回复，只显示一次
  assert.deepEqual(planDisplay({ plan: '整理结构', reply: '整理结构' }, true), { body: '整理结构', note: '' })
  assert.deepEqual(planDisplay({ plan: steps, reply: '' }, true), { body: steps, note: '' })
  assert.equal(planDisplay({ plan: undefined, reply: '只是回复' }, true), null)
})

test('计划框：Fuxi 的计划正文就是模型回复，只显示一次', () => {
  assert.deepEqual(planDisplay({ plan: '内核摘要', reply: '模型写的计划' }, false), { body: '模型写的计划', note: '' })
  assert.deepEqual(planDisplay({ plan: '原验收：画出流程\n1. 读画布', reply: '' }, false), { body: '1. 读画布', note: '' })
  assert.equal(planBody('a\n用 /execute 执行，/plan clear 放弃\nb'), 'a\nb')
})
