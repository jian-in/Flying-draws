// 按作者筛选和遮罩画布元素。
import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import type { Api, HiddenMap, AuthorFilter, SeatEntry, SceneEl, Loose } from './types'
import { unmaskElements, AGENT_COLOR } from './scene'

export function extractSeats(elements: readonly SceneEl[]): { seats: SeatEntry[]; hasAnonAgent: boolean } {
  const map = new Map<string, SeatEntry>()
  let hasAnonAgent = false
  for (const el of elements) {
    if (el.isDeleted) continue
    const mark = el.customData?.flyingdraws
    if (mark?.role === 'marker' || mark?.role === 'move-ghost' || mark?.author !== 'agent') continue
    if (typeof mark.agent === 'string' && mark.agent) {
      const existing = map.get(mark.agent)
      const color = typeof mark.color === 'string' && mark.color ? mark.color : (el.strokeColor || AGENT_COLOR)
      const explicit = Boolean(mark.seat)
      if (!existing) map.set(mark.agent, { name: mark.agent, color, explicit })
      else if (explicit && !existing.explicit) map.set(mark.agent, { ...existing, explicit: true, color })
    } else {
      hasAnonAgent = true
    }
  }
  return { seats: [...map.values()], hasAnonAgent }
}

export const isDynamicSeats = (info: { seats: SeatEntry[]; hasAnonAgent: boolean }): boolean =>
  info.seats.some((s) => s.explicit) || info.seats.length >= 2

export const seatsKeyOf = (info: { seats: SeatEntry[]; hasAnonAgent: boolean }): string =>
  `${info.seats.map((s) => `${s.name}:${s.color}:${s.explicit ? 1 : 0}`).join('|')}#${info.hasAnonAgent ? 1 : 0}`

export function primaryAgentOf(elements: readonly SceneEl[], preferred: string | null): string | null {
  if (preferred) return preferred
  for (const el of elements) {
    if (el.isDeleted) continue
    const a = el.customData?.flyingdraws?.agent
    if (typeof a === 'string' && a) return a
  }
  return null
}

export function matchesFilter(
  el: SceneEl,
  byId: Map<string, SceneEl>,
  filter: AuthorFilter,
  primaryAgent: string | null,
  dynamicSeats: boolean
): boolean {
  if (filter === 'all') return true
  const loose = el as Loose
  const host = loose.type === 'text' && loose.containerId ? (byId.get(loose.containerId) ?? el) : el
  const mark = host.customData?.flyingdraws
  if (filter === 'user') return mark?.author !== 'agent'
  if (mark?.author !== 'agent') return false
  if (filter.startsWith('seat:')) return mark.agent === filter.slice(5)
  if (dynamicSeats && filter === 'agent') return !(typeof mark.agent === 'string' && mark.agent)
  const name = typeof mark.agent === 'string' && mark.agent ? mark.agent : null
  const bucket = !name || !primaryAgent || name === primaryAgent ? 'agent' : 'other'
  return bucket === filter
}

export function applyAuthorFilter(api: Api, nextFilter: AuthorFilter, hidden: HiddenMap, preferredAgent: string | null, dynamicSeats: boolean): void {
  const raw = api.getSceneElementsIncludingDeleted()
  const restored = unmaskElements(raw, hidden)
  hidden.clear()

  let finalElements = restored
  if (nextFilter !== 'all') {
    const byId = new Map(restored.map((el) => [el.id, el]))
    const primary = primaryAgentOf(restored, preferredAgent)
    finalElements = restored.map((el) => {
      if (el.isDeleted) return el
      if (matchesFilter(el, byId, nextFilter, primary, dynamicSeats)) return el
      hidden.set(el.id, { opacity: el.opacity ?? 100, locked: Boolean(el.locked) })
      // 不改 el.version：筛选显示不触发自动保存和版本号变化
      return { ...el, opacity: 0, locked: true, versionNonce: Math.floor(Math.random() * 1e9) }
    })
  }
  api.updateScene({
    elements: finalElements,
    captureUpdate: CaptureUpdateAction.NEVER
  })
}
