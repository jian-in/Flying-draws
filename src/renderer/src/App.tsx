import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { createPortal } from 'react-dom'
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

// 画布默认是淡黄的纸色。用户自己换过背景色的画板不动，只把还是默认白底的换掉。
const PAPER_COLOR = '#fffbe6'
const paperOr = (color: unknown): string =>
  typeof color === 'string' && color && color.toLowerCase() !== '#ffffff' ? color : PAPER_COLOR

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

const BANNER_HEIGHT = 190 // 确认横幅大约占画布顶部这么高（屏幕像素）

// 把视野移到一批元素上，不改缩放。belowBanner 为 true 时把内容往下让一让，别被顶部的横幅挡住。
function showElements(api: Api, elements: readonly SceneEl[], belowBanner: boolean): void {
  if (!elements.length) return
  if (!belowBanner) {
    api.scrollToContent(elements, { fitToContent: false, animate: true })
    return
  }
  // 自己算滚动位置：把内容放在横幅下面那块区域的正中间；内容比那块区域还高时，顶部对齐到横幅下沿
  const minX = Math.min(...elements.map((el) => Math.min(el.x, el.x + el.width)))
  const maxX = Math.max(...elements.map((el) => Math.max(el.x, el.x + el.width)))
  const minY = Math.min(...elements.map((el) => Math.min(el.y, el.y + el.height)))
  const maxY = Math.max(...elements.map((el) => Math.max(el.y, el.y + el.height)))
  const s = api.getAppState()
  const zoom = s.zoom.value
  const room = s.height - BANNER_HEIGHT
  const top = (maxY - minY) * zoom > room - 40 ? BANNER_HEIGHT + 20 : BANNER_HEIGHT + (room - (maxY - minY) * zoom) / 2
  api.updateScene({
    appState: {
      scrollX: s.width / 2 / zoom - (minX + maxX) / 2,
      scrollY: top / zoom - minY
    }
  })
}

// agent 画的东西一律用蓝色，和用户画的区分开。还没确认的提议再加上虚线和半透明。
const AGENT_COLOR = '#1971c2'
const PROPOSAL_OPACITY = 55

// 这里要读写的字段比 Excalidraw 的联合类型好写得多，统一按这个形状看待元素
type Loose = SceneEl & {
  containerId?: string | null
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
  points?: readonly (readonly [number, number])[]
}
const patch = (el: SceneEl, changes: Record<string, unknown>): SceneEl =>
  newElementWith(el, changes as Parameters<typeof newElementWith>[1]) as SceneEl

// 执行计划里的"改字"和"删除"。主进程已经确认过这些都是 agent 自己画的。
// 删节点时，绑在上面的文字和连着它的 agent 连线一起删；用户画的连线留着，只把那一头松开。
function applyChanges(elements: SceneEl[], plan: DrawPlan): SceneEl[] {
  if (!plan.updates.length && !plan.deletes.length) return elements
  const byId = new Map(elements.map((el) => [el.id, el]))
  const gone = new Set(plan.deletes)
  const goneNodes = new Set(plan.deletes.filter((id) => byId.get(id)?.type !== 'arrow'))
  for (const el of elements as Loose[]) {
    if (el.isDeleted || el.type !== 'arrow' || el.customData?.sketchlink?.author !== 'agent') continue
    if ((el.startBinding && goneNodes.has(el.startBinding.elementId)) || (el.endBinding && goneNodes.has(el.endBinding.elementId))) gone.add(el.id)
  }

  // 改字：不直接改旧文字（尺寸和换行都要重算），而是让 Excalidraw 按新文字重新生成一个，替换掉旧的
  const replaced = new Map<string, SceneEl>()
  const added: SceneEl[] = []
  for (const u of plan.updates) {
    const target = byId.get(u.elementId) as Loose | undefined
    if (!target || target.isDeleted) continue
    const old = (elements as Loose[]).find((el) => !el.isDeleted && el.type === 'text' && el.containerId === target.id)
    if (old) gone.add(old.id)
    let bound = (target.boundElements ?? []).filter((b) => b.id !== old?.id)
    const grow: Record<string, unknown> = {}
    if (u.label) {
      const shape = { type: target.type, id: 'sl_tmp', x: target.x, y: target.y, width: target.width, height: target.height, label: { text: u.label } }
      const skeleton = target.type === 'arrow' ? { ...shape, points: target.points } : shape
      const made = convertToExcalidrawElements([skeleton] as unknown as SkeletonList, { regenerateIds: false })
      const text = made.find((el) => el.type === 'text')
      const box = made.find((el) => el.type !== 'text')
      if (text) {
        added.push({
          ...text,
          id: u.textId,
          containerId: target.id,
          strokeColor: target.strokeColor,
          opacity: target.opacity,
          customData: target.customData
        } as unknown as SceneEl)
        bound = [...bound, { type: 'text', id: u.textId }]
      }
      // 新文字放不下时节点会长高
      if (target.type !== 'arrow' && box && box.height > target.height) grow.height = box.height
    }
    replaced.set(target.id, patch(target, { ...grow, boundElements: bound }))
  }

  for (const el of elements as Loose[]) if (!el.isDeleted && el.type === 'text' && el.containerId && gone.has(el.containerId)) gone.add(el.id)

  const kept = elements.map((original) => {
    let el = (replaced.get(original.id) ?? original) as Loose
    if (gone.has(el.id)) return el.isDeleted ? el : patch(el, { isDeleted: true })
    if (el.boundElements?.some((b) => gone.has(b.id))) el = patch(el, { boundElements: el.boundElements.filter((b) => !gone.has(b.id)) }) as Loose
    if (el.type === 'arrow') {
      if (el.startBinding && gone.has(el.startBinding.elementId)) el = patch(el, { startBinding: null }) as Loose
      if (el.endBinding && gone.has(el.endBinding.elementId)) el = patch(el, { endBinding: null }) as Loose
    }
    return el
  })
  return [...kept, ...added]
}

// 把主进程排好的绘图计划画到画布上。已有元素只会按计划改字或删除，以及补上"有箭头连着我"的记录。
// proposalId 不为空时画在提议层上，等用户确认。
async function applyPlan(api: Api, plan: DrawPlan, proposalId: string | null): Promise<{ sceneJson: string }> {
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
      width: Math.max(...e.points.map((p) => p[0])) - Math.min(...e.points.map((p) => p[0])),
      height: Math.max(...e.points.map((p) => p[1])) - Math.min(...e.points.map((p) => p[1])),
      points: e.points,
      // 有拐点的连线画成圆滑的曲线，和用户手画的箭头一个样子
      ...(e.points.length > 2 ? { roundness: { type: 2 } } : {}),
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
  const look = proposalId
    ? { strokeColor: AGENT_COLOR, opacity: PROPOSAL_OPACITY, strokeStyle: 'dashed' as const }
    : { strokeColor: AGENT_COLOR }
  const mark = proposalId ? { author: 'agent', layer: 'proposal', proposal: proposalId } : { author: 'agent', layer: 'final' }
  const fresh = created.map((el) => {
    const tagged = { ...el, ...look, customData: { ...el.customData, sketchlink: mark } }
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
    elements: [...applyChanges(current.map(withArrows), plan), ...fresh.map(withArrows)],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY // 用户可以用撤销去掉 agent 画的这一批
  })
  showElements(api, fresh, Boolean(proposalId))
  return { sceneJson: (await snapshot(api, false)).sceneJson }
}

// 用户对一个提议做了决定。接受：提议层上的元素变成正式内容（实线、不透明，仍是蓝色）；
// 拒绝：删掉。用户在提议上改过的地方原样保留，用户自己删掉的不会回来。
function resolveProposal(api: Api, proposalId: string, accept: boolean): void {
  const isProposed = (el: SceneEl): boolean => {
    const mark = el.customData?.sketchlink
    return !el.isDeleted && mark?.layer === 'proposal' && mark?.proposal === proposalId
  }
  const all = api.getSceneElementsIncludingDeleted()
  const removed = new Set(accept ? [] : all.filter(isProposed).map((el) => el.id))
  const elements = all.map((el) => {
    if (isProposed(el)) {
      return accept
        ? newElementWith(el, {
            opacity: 100,
            strokeStyle: 'solid',
            customData: { ...el.customData, sketchlink: { author: 'agent', layer: 'final' } }
          })
        : newElementWith(el, { isDeleted: true })
    }
    // 删掉提议里的箭头后，把别的节点上"有箭头连着我"的记录也清掉
    if (removed.size && el.boundElements?.some((b) => removed.has(b.id))) {
      return newElementWith(el, { boundElements: el.boundElements.filter((b) => !removed.has(b.id)) })
    }
    return el
  })
  api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
}

type Status =
  | { kind: 'loading' }
  | { kind: 'idle' }
  | { kind: 'saved'; path: string; version: number; savedAt: string }
  | { kind: 'error'; message: string }

export default function App() {
  const [api, setApi] = useState<Api | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [boardInfo, setBoardInfo] = useState<{ board: string; title: string | null }>({ board: 'default', title: null })
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [hub, setHub] = useState<HubState>({ pending: [], agentWaiting: false, inbox: 0 })
  const [toast, setToast] = useState<string | null>(null)
  const hubRef = useRef(hub)
  hubRef.current = hub

  // 几秒后自动消失的提示
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  // 收件箱里的画被 agent 取走了：告诉用户一声
  const lastInbox = useRef(0)
  useEffect(() => {
    if (hub.inbox < lastInbox.current) setToast('agent 已经取走你的画')
    lastInbox.current = hub.inbox
  }, [hub.inbox])
  const [composing, setComposing] = useState(false)
  const [initialData] = useState(() =>
    window.sketchlink.loadBoard().then((res) => {
      setBoardInfo({ board: res.board, title: res.title })
      setBoards(res.boards)
      setStatus(res.json ? { kind: 'saved', path: res.path, version: res.version, savedAt: new Date().toISOString() } : { kind: 'idle' })
      const scene = res.json ? (JSON.parse(res.json) as { appState?: Record<string, unknown> }) : {}
      return { ...scene, appState: { ...scene.appState, viewBackgroundColor: paperOr(scene.appState?.viewBackgroundColor) } }
    })
  )

  const latest = useRef<SceneArgs | null>(null)
  const lastSavedVersion = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const apiRef = useRef<Api | null>(null)
  apiRef.current = api

  const applyLoadedScene = useCallback(
    (
      currentApi: Api,
      res: {
        board: string
        title: string | null
        version: number
        json: string | null
        path?: string
        boards?: BoardSummary[]
        hubState?: HubState
      }
    ) => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
      const parsed = res.json ? (JSON.parse(res.json) as { elements?: SceneEl[]; appState?: Record<string, unknown>; files?: Record<string, unknown> }) : null
      const nextElements = parsed?.elements ?? []
      lastSavedVersion.current = elementsVersion(nextElements)
      latest.current = null
      currentApi.resetScene()
      if (parsed?.files && Object.keys(parsed.files).length > 0) {
        currentApi.addFiles(Object.values(parsed.files) as Parameters<Api['addFiles']>[0])
      }
      const nextAppState: Record<string, unknown> = { ...parsed?.appState }
      delete nextAppState.collaborators
      nextAppState.viewBackgroundColor = paperOr(nextAppState.viewBackgroundColor)
      currentApi.updateScene({
        elements: nextElements,
        appState: nextAppState as unknown as Parameters<Api['updateScene']>[0]['appState'],
        captureUpdate: CaptureUpdateAction.NEVER
      })
      currentApi.history.clear()
      setBoardInfo({ board: res.board, title: res.title })
      if (res.boards) setBoards(res.boards)
      else void window.sketchlink.listBoards().then((list) => setBoards(list.boards))
      if (res.hubState) {
        lastInbox.current = res.hubState.inbox
        setHub(res.hubState)
      }
      setComposing(false)
      setStatus(
        res.json && res.path
          ? { kind: 'saved', path: res.path, version: res.version, savedAt: new Date().toISOString() }
          : { kind: 'idle' }
      )
    },
    []
  )

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
      // 横幅和弹窗画在 Excalidraw 外面，要自己跟着它的深浅色走
      if (document.documentElement.dataset.slTheme !== appState.theme) {
        document.documentElement.dataset.slTheme = appState.theme
      }
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
    const off = window.sketchlink.onHubState(setHub)
    void window.sketchlink.getHubState().then(setHub)
    return off
  }, [])

  // 处理主进程发来的调用。画布 API 准备好以后才通知主进程"页面就绪"
  useEffect(() => {
    if (!api) return
    const off = window.sketchlink.onRpc(async ({ id, method, params }) => {
      const current = apiRef.current
      try {
        if (!current) throw new Error('canvas is not ready')
        if (method === 'snapshot') {
          const withImage = Boolean((params as { image?: boolean })?.image)
          window.sketchlink.rpcReply(id, await snapshot(current, withImage))
        } else if (method === 'applyPlan') {
          const { plan, proposalId } = params as { plan: DrawPlan; proposalId: string | null }
          window.sketchlink.rpcReply(id, await applyPlan(current, plan, proposalId))
        } else if (method === 'loadScene') {
          const next = params as { board: string; title: string | null; version: number; json: string | null }
          applyLoadedScene(current, next)
          window.sketchlink.rpcReply(id, { ok: true })
        } else if (method === 'syncBoards') {
          const next = params as {
            board: string
            title: string | null
            version: number
            boards: BoardSummary[]
            hubState: HubState
          }
          setBoardInfo({ board: next.board, title: next.title })
          setBoards(next.boards)
          lastInbox.current = next.hubState.inbox
          setHub(next.hubState)
          setStatus((prev) =>
            prev.kind === 'saved' ? { ...prev, version: next.version, savedAt: new Date().toISOString() } : prev
          )
          window.sketchlink.rpcReply(id, { ok: true })
        } else {
          throw new Error(`unknown method ${method}`)
        }
      } catch (err) {
        window.sketchlink.rpcReply(id, null, err instanceof Error ? err.message : String(err))
      }
    })
    window.sketchlink.ready()
    return off
  }, [api, applyLoadedScene])

  const handleSwitchBoard = useCallback(
    async (targetBoard: string) => {
      const current = apiRef.current
      if (!current || targetBoard === boardInfo.board) return
      try {
        const snap = await snapshot(current, false)
        const res = await window.sketchlink.switchBoard({ board: targetBoard, currentSceneJson: snap.sceneJson })
        applyLoadedScene(current, res)
      } catch (err) {
        setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    },
    [applyLoadedScene, boardInfo.board]
  )

  const handleCreateBoard = useCallback(
    async (rawName: string) => {
      const current = apiRef.current
      if (!current) return
      const trimmed = rawName.trim()
      const snap = await snapshot(current, false)
      const res = await window.sketchlink.createBoard({
        name: trimmed,
        title: /\s/.test(trimmed) ? trimmed : undefined,
        currentSceneJson: snap.sceneJson
      })
      applyLoadedScene(current, res)
      setCreating(false)
      setToast(`已新建画板「${res.board}」`)
    },
    [applyLoadedScene]
  )

  const handleRenameBoard = useCallback(async (rawName: string) => {
    const current = apiRef.current
    if (!current) return
    const trimmed = rawName.trim()
    const snap = await snapshot(current, false)
    const res = await window.sketchlink.renameBoard({
      board: boardInfo.board,
      name: trimmed,
      title: /\s/.test(trimmed) ? trimmed : null,
      currentSceneJson: snap.sceneJson
    })
    setBoardInfo({ board: res.board, title: res.title })
    setBoards(res.boards)
    if (res.hubState) {
      lastInbox.current = res.hubState.inbox
      setHub(res.hubState)
    }
    setStatus({ kind: 'saved', path: res.path, version: res.version, savedAt: new Date().toISOString() })
    setRenaming(false)
    setToast(`已重命名画板为「${res.board}」`)
  }, [boardInfo.board])

  const handleDeleteBoard = useCallback(async () => {
    const current = apiRef.current
    if (!current) return
    const snap = await snapshot(current, false)
    const target = boardInfo.board
    const res = await window.sketchlink.deleteBoard({
      board: target,
      currentSceneJson: snap.sceneJson
    })
    applyLoadedScene(current, res)
    setConfirmDelete(false)
    setToast(`已删除画板「${res.deleted ?? target}」`)
  }, [applyLoadedScene, boardInfo.board])

  const submit = useCallback(
    async (requestId: string | null, note: string) => {
      if (!apiRef.current) return
      // 有 agent 正等着（或者这是在回应它的请求）时，画会直接交到它手上；否则先放进收件箱
      const direct = requestId !== null || hubRef.current.agentWaiting
      const snap = await snapshot(apiRef.current, true)
      await window.sketchlink.submit({ requestId, note, ...snap })
      if (direct) setToast('agent 已经收到你的画')
      lastSavedVersion.current = elementsVersion(apiRef.current.getSceneElements())
      setComposing(false)
    },
    []
  )

  // 回应 agent 的提议：先把提议层上的元素合并或删掉，再把结果发给 agent
  const decide = useCallback(async (requestId: string, proposalId: string, accept: boolean, note: string) => {
    const current = apiRef.current
    if (!current) return
    resolveProposal(current, proposalId, accept)
    const snap = await snapshot(current, true)
    await window.sketchlink.submit({ requestId, note, decision: accept ? 'accepted' : 'rejected', ...snap })
    lastSavedVersion.current = elementsVersion(current.getSceneElements())
  }, [])

  // 请求按先来后到一个一个处理，横幅上写明后面还排着几个
  const request = hub.pending[0] ?? null
  const queued = Math.max(0, hub.pending.length - 1)

  // 轮到一个提议时，把视野移到它上面：画布上可能同时有好几个提议，要让用户知道现在问的是哪一个
  const requestId = request?.id ?? null
  const proposalId = request?.kind === 'proposal' ? request.proposalId : null
  useEffect(() => {
    if (!api || !proposalId) return
    // 应用刚启动时画板可能还没载入完，等提议的元素出现了再移
    let tries = 0
    const timer = setInterval(() => {
      const mine = api.getSceneElements().filter((el) => el.customData?.sketchlink?.proposal === proposalId)
      if (!mine.length && ++tries < 20) return
      clearInterval(timer)
      showElements(api, mine, true)
    }, 250)
    return () => clearInterval(timer)
  }, [api, requestId, proposalId])

  // 端到端测试要直接操作画布（模拟用户拖动、改字），只在隔离的测试实例上开放
  useEffect(() => {
    if (api && window.sketchlink.testMode) (window as unknown as { __sketchlinkApi?: Api }).__sketchlinkApi = api
  }, [api])

  const nextBoardName = () => {
    const used = new Set(boards.map((b) => b.board))
    for (let i = 1; ; i++) {
      const candidate = `board-${i}`
      if (!used.has(candidate)) return candidate
    }
  }

  return (
    <>
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData}
        onChange={onChange}
        langCode="zh-CN"
        renderTopRightUI={() => (
          <div className="sl-status">
            <select
              className="sl-board-select"
              aria-label="切换画板"
              title="切换当前画板"
              value={boardInfo.board}
              onChange={(e) => void handleSwitchBoard(e.target.value)}
            >
              {boards.some((b) => b.board === boardInfo.board) ? null : (
                <option value={boardInfo.board}>{boardInfo.title || boardInfo.board}</option>
              )}
              {boards.map((b) => (
                <option key={b.board} value={b.board}>
                  {b.title ? `${b.title} (${b.board})` : b.board}
                </option>
              ))}
            </select>
            <button
              className="sl-icon sl-new-board"
              onClick={() => setCreating(true)}
              aria-label="新建画板"
              title="新建一块空白画板"
            >
              +
            </button>
            <MoreMenu
              items={[
                { label: '重命名', title: '重命名当前画板', onSelect: () => setRenaming(true) },
                { label: '立即保存', title: '立即把当前画布写入文件', onSelect: () => void save() },
                {
                  label: '打开文件位置',
                  title: '在资源管理器中显示画板文件',
                  onSelect: () => void window.sketchlink.revealBoard()
                },
                {
                  label: '删除',
                  title: boards.length <= 1 ? '至少保留一块画板' : '删除当前画板',
                  danger: true,
                  disabled: boards.length <= 1,
                  onSelect: () => setConfirmDelete(true)
                }
              ]}
            />
            <StatusText status={status} />
            <button className="sl-primary" onClick={() => setComposing(true)} title="把当前画布发给 agent">
              发给 agent
            </button>
          </div>
        )}
      />
      {creating ? (
        <BoardNameModal
          modeTitle="新建画板"
          submitLabel="创建"
          busyLabel="创建中…"
          defaultName={nextBoardName()}
          onSubmit={handleCreateBoard}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {renaming ? (
        <BoardNameModal
          modeTitle="重命名画板"
          submitLabel="保存"
          busyLabel="保存中…"
          defaultName={boardInfo.title ?? boardInfo.board}
          onSubmit={handleRenameBoard}
          onClose={() => setRenaming(false)}
        />
      ) : null}
      {confirmDelete ? (
        <ConfirmModal
          title="删除画板"
          message={`确定要删除画板「${boardInfo.title ? `${boardInfo.title} (${boardInfo.board})` : boardInfo.board}」吗？文件会从磁盘移除，无法恢复。`}
          confirmLabel="确认删除"
          busyLabel="删除中…"
          onConfirm={handleDeleteBoard}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
      {request && request.kind === 'proposal' && request.proposalId ? (
        <Banner
          key={request.id}
          title="agent 画了它的理解（蓝色虚线部分），可以直接在上面改："
          prompt={request.prompt}
          queued={queued}
          onSend={(note) => decide(request.id, request.proposalId!, true, note)}
          sendLabel="对，就这样"
          onCancel={(note) => decide(request.id, request.proposalId!, false, note)}
          cancelLabel="不对，去掉"
        />
      ) : request ? (
        <Banner
          key={request.id}
          title="agent 请你画："
          prompt={request.prompt}
          queued={queued}
          onSend={(note) => submit(request.id, note)}
          onCancel={() => void window.sketchlink.cancel(request.id)}
          cancelLabel="不画了"
        />
      ) : composing ? (
        <Banner
          title="把当前画布发给 agent"
          prompt={
            hub.agentWaiting
              ? 'agent 正在等你的画，发出后它马上就能看到。'
              : 'agent 现在没在等。发出后要在聊天里跟它说一声「画好了」，它才会来取。'
          }
          onSend={(note) => submit(null, note)}
          onCancel={() => setComposing(false)}
          cancelLabel="取消"
        />
      ) : hub.agentWaiting ? (
        <div className="sl-waiting sl-waiting-live">agent 正在等你：画好后点右上角「发给 agent」</div>
      ) : hub.inbox > 0 ? (
        <div className="sl-waiting">
          已发出{hub.inbox > 1 ? ` ${hub.inbox} 份` : ''}，agent 还没来取。在聊天里跟它说一声「画好了」
        </div>
      ) : null}
      {toast ? (
        <div className="sl-toast" role="status">
          {toast}
        </div>
      ) : null}
    </>
  )
}

function BoardNameModal(props: {
  modeTitle: string
  submitLabel: string
  busyLabel: string
  defaultName: string
  onSubmit: (name: string) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(props.defaultName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (!name.trim()) {
      setError('画板名称不能为空')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await props.onSubmit(name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }
  return (
    <div className="sl-modal-backdrop" onClick={() => !busy && props.onClose()}>
      <div className="sl-modal" role="dialog" aria-label={props.modeTitle} onClick={(e) => e.stopPropagation()}>
        <div className="sl-modal-title">{props.modeTitle}</div>
        <input
          autoFocus
          value={name}
          placeholder="例如：login-flow 或 登录流程"
          onFocus={(e) => e.target.select()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !busy) void submit()
            if (e.key === 'Escape' && !busy) props.onClose()
          }}
        />
        {error ? <div className="sl-error">{error}</div> : null}
        <div className="sl-modal-actions">
          <button onClick={props.onClose} disabled={busy}>
            取消
          </button>
          <button className="sl-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? props.busyLabel : props.submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function ConfirmModal(props: {
  title: string
  message: string
  confirmLabel: string
  busyLabel: string
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await props.onConfirm()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }
  return (
    <div className="sl-modal-backdrop" onClick={() => !busy && props.onClose()}>
      <div
        className="sl-modal"
        role="dialog"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' && !busy) props.onClose()
        }}
      >
        <div className="sl-modal-title">{props.title}</div>
        <div>{props.message}</div>
        {error ? <div className="sl-error">{error}</div> : null}
        <div className="sl-modal-actions">
          <button autoFocus onClick={props.onClose} disabled={busy}>
            取消
          </button>
          <button className="sl-danger" onClick={() => void confirm()} disabled={busy}>
            {busy ? props.busyLabel : props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function Banner(props: {
  title: string
  prompt: string
  queued?: number // 这个请求后面还排着几个
  onSend: (note: string) => Promise<void>
  sendLabel?: string
  onCancel: (note: string) => void | Promise<void>
  cancelLabel: string
}) {
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: (note: string) => void | Promise<void>) => {
    setSending(true)
    setError(null)
    try {
      await action(note)
    } catch (err) {
      setError(String(err))
      setSending(false)
    }
  }
  const send = () => run(props.onSend)
  return (
    <div className="sl-banner" role="dialog" aria-label={props.title}>
      <div className="sl-banner-title">{props.title}</div>
      <div className="sl-banner-prompt">{props.prompt}</div>
      {props.queued ? <div className="sl-banner-queued">处理完这个，后面还有 {props.queued} 个请求</div> : null}
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
        <button onClick={() => void run(props.onCancel)} disabled={sending}>
          {props.cancelLabel}
        </button>
        <button className="sl-primary" onClick={() => void send()} disabled={sending}>
          {sending ? '发送中…' : (props.sendLabel ?? '发送')}
        </button>
      </div>
    </div>
  )
}

type MenuItem = { label: string; title?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }

// 右上角的「⋯」菜单：不常用的画板操作收在这里，免得和 Excalidraw 的工具栏抢位置
function MoreMenu({ items }: { items: MenuItem[] }) {
  // 菜单挂到 body 上（不然会被横幅盖住），位置按按钮算：右边对齐，贴在按钮下面
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const open = pos !== null
  const setOpen = (next: boolean | ((v: boolean) => boolean)) =>
    setPos((prev) => {
      const want = typeof next === 'function' ? next(prev !== null) : next
      const rect = wrap.current?.getBoundingClientRect()
      return want && rect ? { top: rect.bottom + 6, right: window.innerWidth - rect.right } : null
    })
  const wrap = useRef<HTMLDivElement | null>(null)
  const menu = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (!wrap.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    const onResize = () => setOpen(false)
    window.addEventListener('resize', onResize)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  return (
    <div className="sl-more-wrap" ref={wrap}>
      <button
        className="sl-icon sl-more"
        aria-label="更多画板操作"
        aria-haspopup="menu"
        aria-expanded={open}
        title="更多"
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {pos
        ? createPortal(
            <div className="sl-menu" role="menu" ref={menu} style={{ top: pos.top, right: pos.right }}>
              {items.map((item) => (
                <button
                  key={item.label}
                  role="menuitem"
                  className={item.danger ? 'sl-menu-danger' : undefined}
                  title={item.title}
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false)
                    item.onSelect()
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

// 保存状态：一个小圆点加两三个字，细节（版本号、时间、路径）放在悬停提示里
function StatusText({ status }: { status: Status }) {
  switch (status.kind) {
    case 'loading':
      return <span className="sl-save">载入中…</span>
    case 'idle':
      return <span className="sl-save">未修改</span>
    case 'saved':
      return (
        <span
          className="sl-save sl-save-ok"
          title={`v${status.version} · ${new Date(status.savedAt).toLocaleTimeString()}\n${status.path}`}
        >
          已保存
        </span>
      )
    case 'error':
      return (
        <span className="sl-save sl-save-error" title={status.message}>
          出错了：{status.message}
        </span>
      )
  }
}
