// 把 Excalidraw 属性面板里「描边宽度」的三个档位按钮换成 0–100 的滑杆。
// Excalidraw 没有开放改属性面板的接口，所以这里找到面板里那一栏，把滑杆挂进去，原来的三个按钮用样式藏掉
// （.fd-stroke-host，见 styles.css）。面板每次重新出现都要重新挂一次。
import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { CaptureUpdateAction, newElementWith, type Excalidraw } from '@excalidraw/excalidraw'
import { sliderToStrokeWidth, strokeWidthToSlider, STROKE_SLIDER_MAX } from './strokeWidth'

type Api = Parameters<NonNullable<ComponentProps<typeof Excalidraw>['excalidrawAPI']>>[0]

const HOST_CLASS = 'fd-stroke-slider'
const FIELDSET_CLASS = 'fd-stroke-host'

// 面板上该显示的宽度：选中了东西就看选中的第一个，没选中就看「接下来要画的」
function currentWidth(api: Api): number {
  const appState = api.getAppState()
  const selected = appState.selectedElementIds ?? {}
  for (const el of api.getSceneElements()) {
    if (selected[el.id] && typeof el.strokeWidth === 'number') return el.strokeWidth
  }
  return appState.currentItemStrokeWidth
}

export function StrokeWidthSlider({ api }: { api: Api }) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [value, setValue] = useState(() => strokeWidthToSlider(currentWidth(api)))
  const rangeRef = useRef<HTMLInputElement | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  // 正拖着滑杆时：记着按下那一刻各个选中元素原来的宽度（没在拖是 null）
  const dragging = useRef<Map<string, number> | null>(null)

  // 找到「描边宽度」那一栏并把挂载点放进去；那一栏消失（取消选中、换工具）后清掉
  useEffect(() => {
    const sync = () => {
      const fieldset = document.querySelector('.excalidraw input[name="stroke-width"]')?.closest('fieldset') ?? null
      if (!fieldset) {
        setHost((prev) => (prev && !prev.isConnected ? null : prev))
        return
      }
      let el = fieldset.querySelector<HTMLElement>(`:scope > .${HOST_CLASS}`)
      if (!el) {
        el = document.createElement('div')
        el.className = HOST_CLASS
        fieldset.appendChild(el)
        fieldset.classList.add(FIELDSET_CLASS)
      }
      const next = el
      setHost((prev) => (prev === next ? prev : next))
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.querySelector('.fd-canvas') ?? document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  // 画布上的选中或默认宽度变了，滑杆跟着走；用户正拖着滑杆时不跟，免得和手上的动作打架
  useEffect(() => {
    let prevElements: unknown = null
    let prevSelected: unknown = null
    let prevDefaultWidth: number | null = null
    return api.onChange((elements, appState) => {
      if (dragging.current) return
      if (
        elements === prevElements &&
        appState.selectedElementIds === prevSelected &&
        appState.currentItemStrokeWidth === prevDefaultWidth
      ) {
        return
      }
      prevElements = elements
      prevSelected = appState.selectedElementIds
      prevDefaultWidth = appState.currentItemStrokeWidth
      const next = strokeWidthToSlider(currentWidth(api))
      setValue((prev) => (prev === next ? prev : next))
    })
  }, [api])

  // 数字跟着滑块走，滑块左边那段轨道着色（和 Excalidraw 自己的透明度滑杆一个样子）
  useEffect(() => {
    const range = rangeRef.current
    const bubble = bubbleRef.current
    if (!range || !bubble) return
    const thumb = 16
    const pct = (value / STROKE_SLIDER_MAX) * 100
    bubble.style.left = `${(value / STROKE_SLIDER_MAX) * (range.offsetWidth - thumb) + thumb / 2}px`
    range.style.background = `linear-gradient(to right, var(--color-slider-track) 0%, var(--color-slider-track) ${pct}%, var(--button-bg) ${pct}%, var(--button-bg) 100%)`
  }, [value, host])

  const setWidths = useCallback(
    (widthOf: (id: string) => number | undefined, capture: boolean, currentItem?: number) => {
      api.updateScene({
        elements: api.getSceneElements().map((el) => {
          const w = widthOf(el.id)
          return w !== undefined && typeof el.strokeWidth === 'number' && el.strokeWidth !== w ? newElementWith(el, { strokeWidth: w }) : el
        }),
        ...(currentItem !== undefined ? { appState: { currentItemStrokeWidth: currentItem } } : {}),
        captureUpdate: capture ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.NEVER
      })
    },
    [api]
  )

  // 拖动过程中只是预览，不记撤销
  const preview = useCallback(
    (next: number) => {
      const px = sliderToStrokeWidth(next)
      const selected = api.getAppState().selectedElementIds ?? {}
      setWidths((id) => (selected[id] ? px : undefined), false, px)
    },
    [api, setWidths]
  )

  // 定下来（松手，或键盘按一下）：记成一步撤销，撤销一次就回到拖动之前。
  // 预览时改动已经不记撤销地写进画布了，所以先悄悄退回按下时的宽度，再把最终宽度作为一步记下来。
  const commit = useCallback(
    (next: number, originals: Map<string, number> | null) => {
      const px = sliderToStrokeWidth(next)
      const selected = api.getAppState().selectedElementIds ?? {}
      if (originals?.size) flushSync(() => setWidths((id) => originals.get(id), false))
      setWidths((id) => (selected[id] ? px : undefined), true, px)
    },
    [api, setWidths]
  )

  const latestValueRef = useRef(value)
  latestValueRef.current = value
  const dragCleanupRef = useRef<(() => void) | null>(null)

  const finishDrag = useCallback(
    (nextValue?: number) => {
      dragCleanupRef.current?.()
      dragCleanupRef.current = null
      const originals = dragging.current
      if (!originals) return
      dragging.current = null
      const next = nextValue ?? (rangeRef.current ? Number(rangeRef.current.value) : latestValueRef.current)
      commit(next, originals)
    },
    [commit]
  )

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.()
      dragCleanupRef.current = null
      dragging.current = null
    }
  }, [])

  if (!host) return null
  return createPortal(
    <div className="range-wrapper">
      <input
        ref={rangeRef}
        type="range"
        className="range-input"
        min={0}
        max={STROKE_SLIDER_MAX}
        step={1}
        value={value}
        aria-label="描边宽度"
        data-testid="fd-stroke-width"
        onPointerDown={(event) => {
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            // 合成事件或指针已失效时忽略
          }
          const selected = api.getAppState().selectedElementIds ?? {}
          const originals = new Map<string, number>()
          for (const el of api.getSceneElements()) {
            if (selected[el.id] && typeof el.strokeWidth === 'number') originals.set(el.id, el.strokeWidth)
          }
          dragging.current = originals
          dragCleanupRef.current?.()
          const onEnd = () => finishDrag()
          window.addEventListener('pointerup', onEnd)
          window.addEventListener('pointercancel', onEnd)
          window.addEventListener('blur', onEnd)
          dragCleanupRef.current = () => {
            window.removeEventListener('pointerup', onEnd)
            window.removeEventListener('pointercancel', onEnd)
            window.removeEventListener('blur', onEnd)
          }
        }}
        onChange={(event) => {
          const next = Number(event.target.value)
          setValue(next)
          // 键盘方向键没有「松手」，每按一下直接算一步
          if (dragging.current) preview(next)
          else commit(next, null)
        }}
        onPointerUp={(event) => finishDrag(Number(event.currentTarget.value))}
        onPointerCancel={(event) => finishDrag(Number(event.currentTarget.value))}
      />
      <div className="value-bubble" ref={bubbleRef}>
        {value !== 0 ? value : null}
      </div>
      <div className="zero-label">0</div>
    </div>,
    host
  )
}
