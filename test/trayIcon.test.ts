import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { trayRepresentations } from '../src/main/trayIcon.ts'

test('托盘在 1×、1.5×、2× 使用对应的普通或红点 PNG', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const plain = trayRepresentations(root)
  const alert = trayRepresentations(root, true)
  for (const [i, size] of [16, 24, 32].entries()) {
    for (const [prefix, rep] of [['icon', plain[i]], ['alert', alert[i]]] as const) {
      assert.equal(rep.scaleFactor, size / 16)
      assert.equal(rep.buffer.toString('ascii', 1, 4), 'PNG')
      assert.equal(rep.buffer.readUInt32BE(16), size)
      assert.equal(rep.buffer.readUInt32BE(20), size)
      assert.deepEqual(rep.buffer, readFileSync(new URL(`../resources/icon/${prefix}-${size}.png`, import.meta.url)))
    }
    assert.notDeepEqual(alert[i].buffer, plain[i].buffer)
  }
})

test('后台提醒：只对新出现的审批提醒一次，托盘提示随状态变化', async () => {
  const { freshApprovals, trayTooltip } = await import('../src/main/agentNotice.ts')
  const approval = (requestId: string, answered = false) => ({ requestId, name: 'mcp_flying_draws_1', description: '', answered })
  const state = (approvals: ReturnType<typeof approval>[], busy = true) => ({
    connection: 'ready' as const, error: null, busy, setupNeeded: false, vision: true, provider: 'p', model: 'm', choices: [],
    toolLabels: { mcp_flying_draws_1: 'flying_draws/canvas_draw' }, workspace: '', activeItemId: 'w',
    items: [{ id: 'w', board: 'default', cwd: '.', sessionId: 's', title: '', runs: [{ id: 'r', mode: 'direct' as const, status: 'running' as const, goal: '', startedAt: '', reply: '', draft: '', tools: [], approvals }] }]
  })
  const seen = new Set<string>()
  assert.deepEqual(freshApprovals(state([approval('a')]), seen), ['在画布上画'])
  assert.deepEqual(freshApprovals(state([approval('a')]), seen), [], '同一项不重复提醒')
  assert.equal(trayTooltip(state([approval('a')])), 'Flying draws · Fuxi 等你确认')
  assert.deepEqual(freshApprovals(state([approval('a', true)]), seen), [])
  assert.equal(seen.size, 0, '答复过的不再占着')
  assert.equal(trayTooltip(state([])), 'Flying draws · Fuxi 正在工作')
  assert.equal(trayTooltip(state([], false)), 'Flying draws')
})
