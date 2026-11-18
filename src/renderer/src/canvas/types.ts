// 画布代码共用的 Excalidraw 类型别名。
import type { ComponentProps } from 'react'
import { newElementWith, type convertToExcalidrawElements, type Excalidraw } from '@excalidraw/excalidraw'

export type ExcalidrawProps = ComponentProps<typeof Excalidraw>

export type OnChange = NonNullable<ExcalidrawProps['onChange']>

export type SceneArgs = Parameters<OnChange>

export type Api = Parameters<NonNullable<ExcalidrawProps['excalidrawAPI']>>[0]

export type HiddenMap = Map<string, { opacity: number; locked: boolean }>

export type AuthorFilter = 'all' | 'user' | 'agent' | 'other' | `seat:${string}`

export interface SeatEntry {
  name: string
  color: string
  explicit: boolean
}

export type ViewBox = { x: number; y: number; w: number; h: number }

export type SkeletonList = NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>

export type SceneElementList = ReturnType<Api['getSceneElementsIncludingDeleted']>

export type SceneEl = SceneElementList[number]

// 这里要读写的字段比 Excalidraw 的联合类型好写得多，统一按这个形状看待元素
export type Loose = SceneEl & {
  containerId?: string | null
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
  points?: readonly (readonly [number, number])[]
  fillStyle?: string
}

export const patch = (el: SceneEl, changes: Record<string, unknown>): SceneEl =>
  newElementWith(el, changes as Parameters<typeof newElementWith>[1]) as SceneEl
