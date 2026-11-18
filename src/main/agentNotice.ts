// 后台常驻时的 Agent 提醒：托盘提示文字，以及哪些审批是新出现、需要提醒的。纯函数，不依赖 Electron。
import { AGENT_SEAT, toolDisplayName, type AgentState } from '../shared/agent.ts'

function pendingApprovals(state: AgentState) {
  return state.items.flatMap(item => item.runs).flatMap(run => run.approvals).filter(approval => !approval.answered)
}

export function hasPendingApprovals(state: AgentState): boolean {
  return pendingApprovals(state).length > 0
}

export function trayTooltip(state: AgentState): string {
  if (pendingApprovals(state).length) return `Flying draws · ${AGENT_SEAT} 等你确认`
  return state.busy ? `Flying draws · ${AGENT_SEAT} 正在工作` : 'Flying draws'
}

/**
 * 还没提醒过的待审批项（可读工具名）。会把它们记进 `seen`，同一项只提醒一次；
 * 已经答复或消失的会从 `seen` 里移除，免得集合越积越大。
 */
export function freshApprovals(state: AgentState, seen: Set<string>): string[] {
  const pending = pendingApprovals(state)
  const live = new Set(pending.map(approval => approval.requestId))
  for (const id of seen) if (!live.has(id)) seen.delete(id)
  const fresh = pending.filter(approval => !seen.has(approval.requestId))
  for (const approval of fresh) seen.add(approval.requestId)
  return fresh.map(approval => toolDisplayName(approval.name, state.toolLabels))
}
