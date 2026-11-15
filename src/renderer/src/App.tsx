import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  exportToBlob,
  newElementWith,
  serializeAsJSON
} from '@excalidraw/excalidraw'
import type { DrawPlan } from '../../main/ops'
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

const USER_BUSY_WAIT_MS = 8000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 用户是不是正在画一笔、拖东西或打字。这时候往画布里写东西会打断手上的动作。
function userIsBusy(api: Api): boolean {
  const s = api.getAppState()
  return Boolean(
    s.newElement ||
      s.multiElement ||
      s.editingTextElement ||
      s.resizingElement ||
      s.selectionElement ||
      s.selectedElementsAreBeingDragged ||
      s.isResizing ||
      s.isRotating
  )
}

type SkeletonList = NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>
type SceneElementList = ReturnType<Api['getSceneElementsIncludingDeleted']>
type SceneEl = SceneElementList[number]

// 把主进程排好的绘图计划画到画布上。只新增元素；已有元素只会被补上"有箭头连着我"的记录。
async function applyPlan(api: Api, plan: DrawPlan): Promise<{ sceneJson: string }> {
  // 用户优先：等用户手上的动作做完（design.md 12.4）
  const deadline = Date.now() + USER_BUSY_WAIT_MS
  while (userIsBusy(api)) {
    if (Date.now() > deadline) throw new Error('the user is in the middle of drawing; wait a moment and call canvas_draw again')
    await sleep(100)
  }

  const current = api.getSceneElementsIncludingDeleted()
  const alive = new Set(current.filter((el) => !el.isDeleted).map((el) => el.id))
  for (const ref of plan.existingRefs) {
    if (!alive.has(ref)) throw new Error('a node these ops refer to was just deleted by the user; call canvas_read and try again')
  }

  const skeletons = [
    ...plan.nodes.map((n) => ({
      type: n.shape,
      id: n.elementId,
      x: n.x,
      y: n.y,
      width: n.w,
      height: n.h,
      ...(n.label ? { label: { text: n.label } } : {})
    })),
    ...plan.edges.map((e) => ({
      type: 'arrow' as const,
      id: e.elementId,
      x: e.x,
      y: e.y,
      width: Math.abs(e.dx),
      height: Math.abs(e.dy),
      points: [
        [0, 0],
        [e.dx, e.dy]
      ],
      endArrowhead: 'arrow' as const,
      ...(e.label ? { label: { text: e.label } } : {})
    })),
    ...plan.texts.map((t) => ({ type: 'text' as const, id: t.elementId, x: t.x, y: t.y, text: t.text }))
  ] as unknown as SkeletonList
  const created = convertToExcalidrawElements(skeletons, { regenerateIds: false })

  // 标上"agent 画的"，并把箭头两端绑到节点上（这样用户拖节点时箭头会跟着走）
  const edgeById = new Map(plan.edges.map((e) => [e.elementId, e]))
  const arrowsOn = new Map<string, { id: string; type: 'arrow' }[]>()
  const attach = (nodeId: string, arrowId: string) => {
    arrowsOn.set(nodeId, [...(arrowsOn.get(nodeId) ?? []), { id: arrowId, type: 'arrow' }])
  }
  const fresh = created.map((el) => {
    const tagged = { ...el, customData: { ...el.customData, sketchlink: { author: 'agent', layer: 'final' } } }
    const edge = edgeById.get(el.id)
    if (!edge || el.type !== 'arrow') return tagged
    attach(edge.fromElementId, el.id)
    attach(edge.toElementId, el.id)
    return {
      ...tagged,
      startBinding: { elementId: edge.fromElementId, focus: 0, gap: 8 },
      endBinding: { elementId: edge.toElementId, focus: 0, gap: 8 }
    }
  }) as SceneEl[]
  const withArrows = (el: SceneEl): SceneEl => {
    const add = arrowsOn.get(el.id)
    if (!add) return el
    return newElementWith(el, { boundElements: [...(el.boundElements ?? []), ...add] })
  }

  api.updateScene({
    elements: [...current.map(withArrows), ...fresh.map(withArrows)],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY // 用户可以用撤销去掉 agent 画的这一批
  })
  // 把视野移到新画的内容上，不改缩放
  api.scrollToContent(fresh, { fitToContent: false, animate: true })
  return { sceneJson: (await snapshot(api, false)).sceneJson }
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
        } else if (method === 'applyPlan') {
          window.sketchlink.rpcReply(id, await applyPlan(current, params as DrawPlan))
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
