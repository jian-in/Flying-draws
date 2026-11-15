import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { Excalidraw, exportToBlob, serializeAsJSON } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'

type ExcalidrawProps = ComponentProps<typeof Excalidraw>
type OnChange = NonNullable<ExcalidrawProps['onChange']>
type SceneArgs = Parameters<OnChange>
type Api = Parameters<NonNullable<ExcalidrawProps['excalidrawAPI']>>[0]

const SAVE_DELAY_MS = 600
const EXPORT_MAX_SIZE = 1600

// 每个元素被改动时 version 会加一（删除也算），求和就能判断画面内容有没有变。
// 光标移动、缩放这类只改 appState 的操作不会触发保存。
function elementsVersion(elements: SceneArgs[0]): number {
  let sum = 0
  for (const el of elements) sum += el.version
  return sum + elements.length
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

// 从画布当前状态取一份快照：场景 JSON，以及可选的 PNG 截图
async function snapshot(api: Api, withImage: boolean): Promise<{ sceneJson: string; pngBase64: string | null }> {
  const elements = api.getSceneElements()
  const appState = api.getAppState()
  const files = api.getFiles()
  const sceneJson = serializeAsJSON(elements, appState, files, 'local')
  let pngBase64: string | null = null
  if (withImage && elements.length > 0) {
    const blob = await exportToBlob({
      elements,
      appState: { ...appState, exportBackground: true, exportWithDarkMode: false },
      files,
      mimeType: 'image/png',
      maxWidthOrHeight: EXPORT_MAX_SIZE,
      exportPadding: 24
    })
    pngBase64 = await blobToBase64(blob)
  }
  return { sceneJson, pngBase64 }
}

type Status =
  | { kind: 'loading' }
  | { kind: 'idle' }
  | { kind: 'saved'; path: string; version: number; savedAt: string }
  | { kind: 'error'; message: string }

export default function App() {
  const [api, setApi] = useState<Api | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [hub, setHub] = useState<HubState>({ pending: [], agentWaiting: false })
  const [composing, setComposing] = useState(false)
  const [initialData] = useState(() =>
    window.sketchlink.loadBoard().then((res) => {
      setStatus({ kind: 'idle' })
      return res.json ? JSON.parse(res.json) : null
    })
  )

  const latest = useRef<SceneArgs | null>(null)
  const lastSavedVersion = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const apiRef = useRef<Api | null>(null)
  apiRef.current = api

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
      setStatus({ kind: 'saved', path: res.path, version: res.version, savedAt: res.savedAt })
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

  // 订阅 agent 请求的状态
  useEffect(() => {
    window.sketchlink.onHubState(setHub)
    void window.sketchlink.getHubState().then(setHub)
  }, [])

  // 处理主进程发来的调用。画布 API 准备好以后才通知主进程"页面就绪"
  useEffect(() => {
    if (!api) return
    window.sketchlink.onRpc(async ({ id, method, params }) => {
      const current = apiRef.current
      try {
        if (!current) throw new Error('canvas is not ready')
        if (method === 'snapshot') {
          const withImage = Boolean((params as { image?: boolean })?.image)
          window.sketchlink.rpcReply(id, await snapshot(current, withImage))
        } else {
          throw new Error(`unknown method ${method}`)
        }
      } catch (err) {
        window.sketchlink.rpcReply(id, null, err instanceof Error ? err.message : String(err))
      }
    })
    window.sketchlink.ready()
  }, [api])

  const submit = useCallback(
    async (requestId: string | null, note: string) => {
      if (!apiRef.current) return
      const snap = await snapshot(apiRef.current, true)
      await window.sketchlink.submit({ requestId, note, ...snap })
      lastSavedVersion.current = elementsVersion(apiRef.current.getSceneElements())
      setComposing(false)
    },
    []
  )

  const request = hub.pending[0] ?? null

  return (
    <>
      <Excalidraw
        excalidrawAPI={setApi}
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
            <button className="sl-primary" onClick={() => setComposing(true)} title="把当前画布发给 agent">
              发给 agent
            </button>
          </div>
        )}
      />
      {request ? (
        <Banner
          key={request.id}
          title="agent 请你画："
          prompt={request.prompt}
          onSend={(note) => submit(request.id, note)}
          onCancel={() => void window.sketchlink.cancel(request.id)}
          cancelLabel="不画了"
        />
      ) : composing ? (
        <Banner
          title="把当前画布发给 agent"
          prompt={hub.agentWaiting ? 'agent 正在等你的画。' : 'agent 下次读取时会收到。'}
          onSend={(note) => submit(null, note)}
          onCancel={() => setComposing(false)}
          cancelLabel="取消"
        />
      ) : hub.agentWaiting ? (
        <div className="sl-waiting">agent 正在等你：画好后点右上角「发给 agent」</div>
      ) : null}
    </>
  )
}

function Banner(props: {
  title: string
  prompt: string
  onSend: (note: string) => Promise<void>
  onCancel: () => void
  cancelLabel: string
}) {
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = async () => {
    setSending(true)
    setError(null)
    try {
      await props.onSend(note)
    } catch (err) {
      setError(String(err))
      setSending(false)
    }
  }
  return (
    <div className="sl-banner" role="dialog" aria-label={props.title}>
      <div className="sl-banner-title">{props.title}</div>
      <div className="sl-banner-prompt">{props.prompt}</div>
      <input
        className="sl-banner-note"
        placeholder="想补充一句话吗？（可不填）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation() // 别让 Excalidraw 把输入当成快捷键
          if (e.key === 'Enter' && !sending) void send()
        }}
      />
      {error ? <div className="sl-error">{error}</div> : null}
      <div className="sl-banner-actions">
        <button onClick={props.onCancel} disabled={sending}>
          {props.cancelLabel}
        </button>
        <button className="sl-primary" onClick={() => void send()} disabled={sending}>
          {sending ? '发送中…' : '发送'}
        </button>
      </div>
    </div>
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
          已保存 v{status.version} · {new Date(status.savedAt).toLocaleTimeString()}
        </span>
      )
    case 'error':
      return <span className="sl-error">保存失败：{status.message}</span>
  }
}
