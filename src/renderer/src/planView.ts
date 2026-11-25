import type { AgentRun } from '../../shared/agent'

/** The kernel's plan summary repeats the whole request; keep only the plan itself. */
export function planBody(plan: string): string {
  const lines = plan.split('\n').filter(line => !(line.includes('/execute') && line.includes('/plan clear')))
  const contract = lines.findIndex(line => line.startsWith('原验收：'))
  return (contract >= 0 ? lines.slice(contract + 1) : lines).join('\n').trim()
}

/**
 * 计划框里显示什么。Fuxi 的计划正文就是模型回复，只显示一次；
 * ACP 的计划是代理发来的结构化步骤，回复是另外的说明：先显示步骤，回复和步骤不同时另作补充说明。
 */
export function planDisplay(run: Pick<AgentRun, 'plan' | 'reply'>, isAcp: boolean): { body: string; note: string } | null {
  if (!run.plan) return null
  const reply = run.reply ?? ''
  if (!isAcp) return { body: reply || planBody(run.plan), note: '' }
  const steps = run.plan.trim()
  return { body: steps, note: reply.trim() && reply.trim() !== steps ? reply : '' }
}
