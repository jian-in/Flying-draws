import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import {
  computeMinimapTransform,
  fullViewportBox,
  minimapLinearPoints,
  minimapShapeFrame,
  minimapToWorld,
  scrollForWorldCenter,
  worldToMinimap,
  type MinimapTransform
} from './canvas/minimapGeometry'
import type { Api, Loose, SceneEl } from './canvas/types'

export interface CanvasMinimapHandle {
  scheduleDraw(): void
}

const MAP_W = 216
const MAP_H = 132
const MAP_PAD = 10
const STORAGE_KEY = 'fd:minimap-open'

function normalizeStrokeColor(color: string | undefined, dark: boolean): string {
  const raw = (color || '').trim()
  if (!raw || raw === 'transparent') return dark ? '#c8c0a6' : '#2b2a26'
  if (dark) {
    const lower = raw.toLowerCase()
    if (lower === '#000' || lower === '#000000' || lower === '#1e1e1e' || lower === '#2b2a26' || lower === '#1b1b1f') {
      return '#dfd7bc'
    }
  }
  return raw
}

function MinimapIcon() {
  return (
    <svg className="fd-minimap-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="2.5" width="12.5" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <rect x="3.8" y="4.8" width="4.2" height="3.2" rx="0.6" fill="currentColor" opacity="0.38" />
      <rect x="7.4" y="6.8" width="4.8" height="4.2" rx="0.8" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

export const CanvasMinimap = forwardRef<CanvasMinimapHandle, { api: Api | null }>(function CanvasMinimap({ api }, ref) {
  const [open, setOpen] = useState<boolean>(() => {
    try { return window.localStorage.getItem(STORAGE_KEY) !== '0' } catch { return true }
  })
  const [dodged, setDodged] = useState(false)
  const [zoomPct, setZoomPct] = useState(100)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number | null>(null)
  const transformRef = useRef<MinimapTransform | null>(null)
  const dragTransformRef = useRef<MinimapTransform | null>(null)
  const draggingRef = useRef(false)
  const lastZoomRef = useRef(100)
  const lastDodgedRef = useRef(false)

  const toggleOpen = (next: boolean) => {
    setOpen(next)
    try { window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0') } catch {}
  }

  const detectLeftInspector = useCallback(() => {
    const leftPanel = document.querySelector<HTMLElement>('.excalidraw .App-menu__left')
    const visible = Boolean(leftPanel && leftPanel.getBoundingClientRect().width > 24 && leftPanel.getBoundingClientRect().height > 24)
    if (visible !== lastDodgedRef.current) {
      lastDodgedRef.current = visible
      setDodged(visible)
    }
  }, [])

  const drawNow = useCallback(() => {
    detectLeftInspector()
    if (!api) return
    const appState = api.getAppState()
    const pct = Math.max(1, Math.round((appState.zoom?.value || 1) * 100))
    if (pct !== lastZoomRef.current) {
      lastZoomRef.current = pct
      setZoomPct(pct)
    }
    if (!open) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const pixelW = Math.round(MAP_W * dpr)
    const pixelH = Math.round(MAP_H * dpr)
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW
      canvas.height = pixelH
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const dark = appState.theme === 'dark'
    const elements = api.getSceneElements() as readonly SceneEl[]
    const viewport = fullViewportBox(appState)
    const transform = draggingRef.current && dragTransformRef.current
      ? dragTransformRef.current
      : computeMinimapTransform(elements as unknown as Loose[], viewport, MAP_W, MAP_H, MAP_PAD)
    transformRef.current = transform

    // 纸面底色 + 细微参考点阵
    ctx.fillStyle = dark ? '#1d1a10' : '#fffdf0'
    ctx.fillRect(0, 0, MAP_W, MAP_H)
    ctx.fillStyle = dark ? 'rgba(233, 226, 200, 0.08)' : 'rgba(43, 42, 38, 0.08)'
    for (let gx = 16; gx < MAP_W; gx += 18) {
      for (let gy = 14; gy < MAP_H; gy += 18) {
        ctx.fillRect(gx, gy, 1, 1)
      }
    }

    // 绘制所有可见图元缩略轮廓
    for (const raw of elements) {
      if (raw.isDeleted || (typeof raw.opacity === 'number' && raw.opacity <= 0)) continue
      const el = raw as Loose
      const role = el.customData?.flyingdraws?.role
      if (role === 'marker' || role === 'move-ghost') continue
      const stroke = normalizeStrokeColor(el.strokeColor as string | undefined, dark)
      const bg = typeof el.backgroundColor === 'string' && el.backgroundColor !== 'transparent' ? el.backgroundColor : null
      const alpha = Math.max(0.18, Math.min(1, (typeof el.opacity === 'number' ? el.opacity : 100) / 100))

      ctx.save()
      ctx.globalAlpha = alpha

      const linear = minimapLinearPoints(el)
      if (linear) {
        const stride = Math.max(1, Math.floor(linear.length / 48))
        ctx.beginPath()
        for (let i = 0; i < linear.length; i += stride) {
          const p = worldToMinimap(linear[i].x, linear[i].y, transform)
          if (i === 0) ctx.moveTo(p.x, p.y)
          else ctx.lineTo(p.x, p.y)
        }
        const last = linear[linear.length - 1]
        const lp = worldToMinimap(last.x, last.y, transform)
        ctx.lineTo(lp.x, lp.y)
        ctx.strokeStyle = stroke
        ctx.lineWidth = el.type === 'freedraw' ? 1.1 : 1
        ctx.stroke()
        ctx.restore()
        continue
      }

      // 容器内的绑定文字跳过单独画框，避免压住父形状
      if (el.type === 'text' && el.containerId) { ctx.restore(); continue }
      // 形状在小地图里按自身中心和旋转角画，和画布上的方向、范围一致
      const frame = minimapShapeFrame(el)
      const center = worldToMinimap(frame.cx, frame.cy, transform)
      const w = Math.max(2, frame.w * transform.scale)
      const h = Math.max(2, frame.h * transform.scale)
      ctx.translate(center.x, center.y)
      if (frame.angle) ctx.rotate(frame.angle)
      const left = -w / 2
      const top = -h / 2

      if (el.type === 'text') {
        ctx.fillStyle = stroke
        ctx.globalAlpha = alpha * 0.55
        const barH = Math.max(1.5, Math.min(3.5, h * 0.45))
        const barW = Math.max(4, w)
        ctx.fillRect(-barW / 2, -barH / 2, barW, barH)
      } else if (el.type === 'ellipse') {
        ctx.beginPath()
        ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2)
        if (bg) { ctx.fillStyle = bg; ctx.globalAlpha = alpha * 0.55; ctx.fill(); ctx.globalAlpha = alpha }
        ctx.strokeStyle = stroke
        ctx.lineWidth = 1
        ctx.stroke()
      } else if (el.type === 'diamond') {
        ctx.beginPath()
        ctx.moveTo(0, top)
        ctx.lineTo(w / 2, 0)
        ctx.lineTo(0, h / 2)
        ctx.lineTo(left, 0)
        ctx.closePath()
        if (bg) { ctx.fillStyle = bg; ctx.globalAlpha = alpha * 0.55; ctx.fill(); ctx.globalAlpha = alpha }
        ctx.strokeStyle = stroke
        ctx.lineWidth = 1
        ctx.stroke()
      } else if (el.type === 'image') {
        ctx.fillStyle = dark ? 'rgba(116, 179, 238, 0.22)' : 'rgba(25, 113, 194, 0.14)'
        ctx.fillRect(left, top, w, h)
        ctx.strokeStyle = dark ? '#74b3ee' : '#1971c2'
        ctx.lineWidth = 1
        ctx.strokeRect(left, top, w, h)
      } else {
        if (bg) {
          ctx.fillStyle = bg
          ctx.globalAlpha = alpha * 0.55
          ctx.fillRect(left, top, w, h)
          ctx.globalAlpha = alpha
        }
        ctx.strokeStyle = stroke
        ctx.lineWidth = 1
        ctx.strokeRect(left, top, w, h)
      }
      ctx.restore()
    }

    if (!transform.hasElements) {
      ctx.fillStyle = dark ? 'rgba(169, 162, 136, 0.65)' : 'rgba(125, 118, 94, 0.7)'
      ctx.font = '11px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('空画板', MAP_W / 2, MAP_H / 2)
    }

    // 当前视口高亮框
    if (viewport) {
      const vtl = worldToMinimap(viewport.x, viewport.y, transform)
      const vw = Math.max(8, viewport.w * transform.scale)
      const vh = Math.max(6, viewport.h * transform.scale)
      const vx = Math.max(1, Math.min(MAP_W - vw - 1, vtl.x))
      const vy = Math.max(1, Math.min(MAP_H - vh - 1, vtl.y))
      ctx.save()
      ctx.fillStyle = dark ? 'rgba(116, 192, 252, 0.16)' : 'rgba(59, 91, 219, 0.12)'
      ctx.fillRect(vx, vy, Math.min(vw, MAP_W - 2), Math.min(vh, MAP_H - 2))
      ctx.strokeStyle = dark ? '#74c0fc' : '#3b5bdb'
      ctx.lineWidth = 1.5
      ctx.strokeRect(vx, vy, Math.min(vw, MAP_W - 2), Math.min(vh, MAP_H - 2))
      ctx.restore()
    }
  }, [api, open, detectLeftInspector])

  const scheduleDraw = useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null
      drawNow()
    })
  }, [drawNow])

  useImperativeHandle(ref, () => ({ scheduleDraw }), [scheduleDraw])

  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scheduleDraw()
    const onResize = () => scheduleDraw()
    window.addEventListener('resize', onResize)
    const parent = hostRef.current?.parentElement
    const observer = parent && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => scheduleDraw()) : null
    if (parent && observer) observer.observe(parent)
    return () => {
      window.removeEventListener('resize', onResize)
      observer?.disconnect()
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [scheduleDraw])

  const panToPointer = (clientX: number, clientY: number) => {
    if (!api || !canvasRef.current) return
    const transform = dragTransformRef.current ?? transformRef.current
    if (!transform) return
    const rect = canvasRef.current.getBoundingClientRect()
    const mx = Math.max(0, Math.min(MAP_W, clientX - rect.left))
    const my = Math.max(0, Math.min(MAP_H, clientY - rect.top))
    const worldPt = minimapToWorld(mx, my, transform)
    const appState = api.getAppState()
    const { scrollX, scrollY } = scrollForWorldCenter(worldPt.x, worldPt.y, appState)
    api.updateScene({ appState: { scrollX, scrollY }, captureUpdate: CaptureUpdateAction.NEVER })
    scheduleDraw()
  }

  const fitAll = () => {
    if (!api) return
    const elements = api.getSceneElements().filter(el => !el.isDeleted && (typeof el.opacity !== 'number' || el.opacity > 0))
    if (!elements.length) return
    api.scrollToContent(elements, { fitToViewport: true, viewportZoomFactor: 0.9, animate: true })
  }

  return (
    <div
      ref={hostRef}
      className={`fd-minimap${open ? '' : ' fd-minimap-collapsed'}${dodged ? ' fd-minimap-dodged' : ''}`}
      aria-label="画布全局预览"
    >
      {open ? (
        <>
          <div className="fd-minimap-bar">
            <span className="fd-minimap-title"><MinimapIcon />全局预览</span>
            <span className="fd-minimap-zoom" title="当前画布缩放倍率">{zoomPct}%</span>
            <button
              type="button"
              className="fd-minimap-btn"
              title="缩放并居中查看全部画布内容"
              aria-label="适应全图"
              onClick={fitAll}
            >⊡</button>
            <button
              type="button"
              className="fd-minimap-btn"
              title="折叠全局预览"
              aria-label="折叠全局预览"
              onClick={() => toggleOpen(false)}
            >−</button>
          </div>
          <canvas
            ref={canvasRef}
            className="fd-minimap-canvas"
            style={{ width: `${MAP_W}px`, height: `${MAP_H}px` }}
            title="点击或拖动快速定位画布视野"
            onPointerDown={e => {
              if (e.button !== 0) return
              e.preventDefault()
              e.stopPropagation()
              draggingRef.current = true
              dragTransformRef.current = transformRef.current
              e.currentTarget.setPointerCapture(e.pointerId)
              panToPointer(e.clientX, e.clientY)
            }}
            onPointerMove={e => {
              if (!draggingRef.current) return
              e.preventDefault()
              panToPointer(e.clientX, e.clientY)
            }}
            onPointerUp={e => {
              if (!draggingRef.current) return
              draggingRef.current = false
              dragTransformRef.current = null
              try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
              scheduleDraw()
            }}
            onPointerCancel={() => {
              draggingRef.current = false
              dragTransformRef.current = null
              scheduleDraw()
            }}
          />
        </>
      ) : (
        <button
          type="button"
          className="fd-minimap-pill"
          title="展开左上角全局预览小地图"
          aria-expanded={false}
          onClick={() => toggleOpen(true)}
        >
          <MinimapIcon />
          <span>全局预览</span>
        </button>
      )}
    </div>
  )
})
