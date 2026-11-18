import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trayIconPixels } from '../src/main/trayIcon.ts'

const pixel = (buffer: Buffer, size: number, x: number, y: number) => {
  const o = (y * size + x) * 4
  return { b: buffer[o], g: buffer[o + 1], r: buffer[o + 2], a: buffer[o + 3] }
}

test('托盘图标：圆角外透明，描边是墨色，纸面是应用主色', () => {
  for (const size of [16, 24, 32]) {
    const icon = trayIconPixels(size)
    assert.equal(icon.length, size * size * 4)
    assert.equal(pixel(icon, size, 0, 0).a, 0, `${size}px 左上角应透明`)
    assert.equal(pixel(icon, size, size - 1, size - 1).a, 0, `${size}px 右下角应透明`)
    const edge = pixel(icon, size, Math.floor(size / 2), 1)
    assert.ok(edge.a > 200 && edge.r < 120, `${size}px 上边应是墨线`)
    // 纸面：左上方远离笔迹的位置
    const paper = pixel(icon, size, Math.round(size * 0.3), Math.round(size * 0.3))
    assert.deepEqual([paper.r, paper.g, paper.b, paper.a], [0xff, 0xdf, 0x70, 255], `${size}px 纸面颜色`)
  }
  assert.throws(() => trayIconPixels(4), /尺寸无效/)
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

test('托盘图标提醒版：右上角是红点，其余和普通图标一致', () => {
  for (const size of [16, 32]) {
    const plain = trayIconPixels(size)
    const alert = trayIconPixels(size, true)
    const dot = pixel(alert, size, Math.round(size * 0.76), Math.round(size * 0.24))
    assert.deepEqual([dot.r, dot.g, dot.b, dot.a], [0xe0, 0x31, 0x31, 255], `${size}px 红点`)
    const corner = Math.round(size * 0.2)
    assert.deepEqual(pixel(alert, size, corner, size - corner - 1), pixel(plain, size, corner, size - corner - 1), `${size}px 左下不受影响`)
  }
})
