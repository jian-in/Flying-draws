import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'

type OnChange = NonNullable<ComponentProps<typeof Excalidraw>['onChange']>
type SceneArgs = Parameters<OnChange>

const SAVE_DELAY_MS = 600

// 每个元素被改动时 version 会加一（删除也算），求和就能判断画面内容有没有变。
// 光标移动、缩放这类只改 appState 的操作不会触发保存。
function elementsVersion(elements: SceneArgs[0]): number {
  let sum = 0
  for (const el of elements) sum += el.version
  return sum + elements.length
}

type Status =
  | { kind: 'loading' }
  | { kind: 'idle'; path: string }
  | { kind: 'saved'; path: string; saveCount: number; savedAt: string }
  | { kind: 'error'; message: string }

export default function App() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [initialData] = useState(() =>
    window.sketchlink.loadBoard().then((res) => {
      setStatus({ kind: 'idle', path: res.path })
      return res.json ? JSON.parse(res.json) : null
    })
  )

  const latest = useRef<SceneArgs | null>(null)
  const lastSavedVersion = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const save = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const scene = latest.current
    if (!scene) return
    const [elements, appState, files] = scene
    try {
      const json = serializeAsJSON(elements, appState, files, 'local')
      const res = await window.sketchlink.saveBoard(json)
      lastSavedVersion.current = elementsVersion(elements)
      setStatus({ kind: 'saved', ...res })
    } catch (err) {
      setStatus({ kind: 'error', message: String(err) })
    }
  }, [])

  const onChange = useCallback<OnChange>(
    (elements, appState, files) => {
      latest.current = [elements, appState, files]
      const version = elementsVersion(elements)
      if (lastSavedVersion.current === null) {
        // 第一次回调是载入已有画板，记下版本，不重复保存
        lastSavedVersion.current = version
        return
      }
      if (version === lastSavedVersion.current) return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void save(), SAVE_DELAY_MS)
    },
    [save]
  )

  // 关窗口前把还没落盘的修改补存一次
  useEffect(() => {
    const flush = () => {
      if (timer.current) void save()
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [save])

  return (
    <Excalidraw
      initialData={initialData}
      onChange={onChange}
      langCode="zh-CN"
      renderTopRightUI={() => (
        <div className="sl-status">
          <StatusText status={status} />
          <button onClick={() => void save()} title="立即把当前画布写入文件">
            立即保存
          </button>
          <button onClick={() => void window.sketchlink.revealBoard()} title="在资源管理器中显示画板文件">
            打开文件位置
          </button>
        </div>
      )}
    />
  )
}

function StatusText({ status }: { status: Status }) {
  switch (status.kind) {
    case 'loading':
      return <span>载入中…</span>
    case 'idle':
      return <span>未修改</span>
    case 'saved':
      return (
        <span title={status.path}>
          已保存 #{status.saveCount} · {new Date(status.savedAt).toLocaleTimeString()}
        </span>
      )
    case 'error':
      return <span className="sl-error">保存失败：{status.message}</span>
  }
}
