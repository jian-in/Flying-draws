import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CaptureUpdateAction, convertToExcalidrawElements, Excalidraw, loadFromBlob, MainMenu, newElementWith, serializeAsJSON, useHandleLibrary } from '@excalidraw/excalidraw'
import { displaySizeForImage, planImageLineage, type LineageCanvasElement } from '../../main/lineage'
import type { DrawPlan, PendingChanges } from '../../main/ops'
import { StrokeWidthSlider } from './StrokeWidthSlider'
import { AgentPanel } from './AgentPanel'
import { AGENT_SEAT } from '../../shared/agent'
import { LIBRARY_CALLBACK_URL } from '../../shared/library'
import { hasUnsafeCustomData, sanitizeElement, sanitizeScene } from '../../shared/sanitizeScene'
import type { OnChange, SceneArgs, Api, HiddenMap, AuthorFilter, SeatEntry, SkeletonList, SceneEl, Loose } from './canvas/types'
import { SAVE_DELAY_MS, elementsVersion, extractPlacedResults, unmaskElements, visibleArea, snapshot, PAPER_COLOR, paperOr, USER_BUSY_WAIT_MS, DEFERRED_NOTICE_MS, sleep, originalImage, userIsBusy, showElements, AGENT_COLOR } from './canvas/scene'
import { extractSeats, isDynamicSeats, seatsKeyOf, applyAuthorFilter } from './canvas/filters'
import { applyPlan } from './canvas/applyPlan'
import { resolveProposal } from './canvas/proposal'
import '@excalidraw/excalidraw/index.css'

type Status =
  | { kind: 'loading' }
  | { kind: 'idle' }
  | { kind: 'saved'; path: string; version: number; savedAt: string }
  | { kind: 'error'; message: string }

const EXCALIDRAW_UI_OPTIONS = { canvasActions: { loadScene: false } } // 打开文件由 importSceneFile 接管（CVE-2026-97224）

export default function App() {
  const [agentOpen, setAgentOpen] = useState(false)
  const [selectedImage, setSelectedImage] = useState<string | null>(null)
  const selectedImageRef = useRef<string | null>(null)
  const [selectedCount, setSelectedCount] = useState(0)
  const selectedCountRef = useRef(0)
  const [deferredDraw, setDeferredDraw] = useState<{ agent: string | null; editingText: boolean } | null>(null)
  const prevElementsRef = useRef<unknown>(null)
  const prevSelectedIdsRef = useRef<unknown>(null)
  const [api, setApi] = useState<Api | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [boardInfo, setBoardInfo] = useState<{ board: string; title: string | null }>({ board: 'default', title: null })
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [hub, setHub] = useState<HubState>({ pending: [], agentWaiting: false, waitingAgents: [], inbox: 0, inboxTargets: [], handoff: null })
  const [toast, setToast] = useState<string | null>(null)
  const [filter, setFilter] = useState<AuthorFilter>('all')
  const [seatInfo, setSeatInfo] = useState<{ seats: SeatEntry[]; hasAnonAgent: boolean }>({ seats: [], hasAnonAgent: false })
  const [placedResultIds, setPlacedResultIds] = useState<ReadonlySet<string>>(() => new Set())
  const filterRef = useRef<AuthorFilter>('all')
  const hiddenStateRef = useRef<HiddenMap>(new Map())
  const primaryAgentRef = useRef<string | null>(null)
  const lastSeatsKeyRef = useRef<string>('')
  const lastPlacedKeyRef = useRef<string>('')
  const insertQueueRef = useRef<Promise<void>>(Promise.resolve())
  const seatInfoRef = useRef(seatInfo)
  seatInfoRef.current = seatInfo
  const hubRef = useRef(hub)
  hubRef.current = hub

  // 几秒后自动消失的提示
  useEffect(() => {
    if (!toast) return
    // 字多的提示（比如告诉用户去哪里粘贴）多留一会儿，够读完
    const t = setTimeout(() => setToast(null), Math.min(8000, Math.max(3000, 1500 + toast.length * 150)))
    return () => clearTimeout(t)
  }, [toast])

  // 收件箱里的画被 agent 取走、或者画笔被接手：告诉用户一声
  const lastInbox = useRef(0)
  useEffect(() => {
    if (hub.inbox < lastInbox.current) setToast('agent 已经取走你的画')
    lastInbox.current = hub.inbox
  }, [hub.inbox])
  const hadHandoff = useRef(false)
  useEffect(() => {
    if (hadHandoff.current && !hub.handoff && !hub.inbox) setToast('画笔已被接手')
    hadHandoff.current = Boolean(hub.handoff)
  }, [hub.handoff, hub.inbox])
  useEffect(() => {
    if (!filter.startsWith('seat:')) return
    const seatName = filter.slice(5)
    if (!seatInfo.seats.some((s) => s.name === seatName) && apiRef.current) {
      filterRef.current = 'all'
      setFilter('all')
      applyAuthorFilter(apiRef.current, 'all', hiddenStateRef.current, primaryAgentRef.current, isDynamicSeats(seatInfo))
    }
  }, [seatInfo, filter])
  const [composing, setComposing] = useState(false)
  const [dock, setDock] = useState<DockState>({ docked: false, side: null, title: null }) // 画布窗口贴在哪个窗口旁边
  useEffect(() => {
    void window.flyingdraws.getDockState().then(setDock)
    return window.flyingdraws.onDockState(setDock)
  }, [])
  const [sendTo, setSendTo] = useState<string | null>(null) // 「发给 agent」时点选的席位，null 是所有 agent
  const [initialData] = useState(() =>
    window.flyingdraws
      .loadBoard()
      .then((res) => {
        boardIdRef.current = res.board
        setBoardInfo({ board: res.board, title: res.title })
        setBoards(res.boards)
        setStatus(res.json ? { kind: 'saved', path: res.path, version: res.version, savedAt: new Date().toISOString() } : { kind: 'idle' })
        const scene = res.json ? sanitizeScene(JSON.parse(res.json) as { elements?: SceneEl[]; appState?: Record<string, unknown> }).scene : {}
        const initTheme = scene.appState?.theme === 'dark' ? 'dark' : 'light'
        document.documentElement.dataset.fdTheme = initTheme
        window.flyingdraws.setTheme(initTheme)
        const info = extractSeats(scene.elements ?? [])
        lastSeatsKeyRef.current = seatsKeyOf(info)
        setSeatInfo(info)
        const initPlaced = extractPlacedResults(scene.elements ?? [])
        lastPlacedKeyRef.current = initPlaced.join('|')
        setPlacedResultIds(new Set(initPlaced))
        return { ...scene, appState: { ...scene.appState, viewBackgroundColor: paperOr(scene.appState?.viewBackgroundColor) } }
      })
      .catch((err) => {
        setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
        return { elements: [], appState: { viewBackgroundColor: PAPER_COLOR } }
      })
  )

  const latest = useRef<SceneArgs | null>(null)
  const lastSavedVersion = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const apiRef = useRef<Api | null>(null)
  apiRef.current = api
  const [libraryAdapter] = useState(
    () =>
      ({
        load: () =>
          window.flyingdraws.loadLibrary() as Promise<{
            libraryItems: Parameters<NonNullable<Api['updateLibrary']>>[0]['libraryItems'] extends infer T
              ? Extract<Awaited<T>, readonly unknown[]>
              : never
          } | null>,
        save: (data: { libraryItems: readonly unknown[] }) => window.flyingdraws.saveLibrary(data)
      }) as NonNullable<Extract<Parameters<typeof useHandleLibrary>[0], { adapter: unknown }>['adapter']>
  )
  useHandleLibrary({ excalidrawAPI: api, adapter: libraryAdapter })

  useEffect(() => {
    return window.flyingdraws.onLibraryInstall((payload) => {
      if (payload.error) {
        setToast(`素材库导入失败：${payload.error}`)
        return
      }
      const current = apiRef.current
      if (!current || !payload.json) return
      const blob = new Blob([payload.json], { type: 'application/json' })
      void current
        .updateLibrary({
          libraryItems: blob,
          merge: true,
          defaultStatus: 'published',
          openLibraryMenu: true
        })
        .then(() => {
          setToast(payload.itemCount ? `已装入 ${payload.itemCount} 个素材到素材库` : '素材已装入素材库')
        })
        .catch((err) => {
          setToast(`素材库解析失败：${err instanceof Error ? err.message : String(err)}`)
        })
    })
  }, [])
  // 画布上现在这份内容属于哪块画板（存盘时带给主进程），以及载入过几次画板（用来认出「存到一半画板换了」）
  const boardIdRef = useRef<string | null>(null)
  const sceneEpoch = useRef(0)

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
      const parsed = res.json
        ? sanitizeScene(JSON.parse(res.json) as { elements?: SceneEl[]; appState?: Record<string, unknown>; files?: Record<string, unknown> }).scene
        : null
      const nextElements = parsed?.elements ?? []
      lastSavedVersion.current = elementsVersion(nextElements)
      latest.current = null
      boardIdRef.current = res.board
      sceneEpoch.current += 1
      hiddenStateRef.current.clear()
      filterRef.current = 'all'
      setFilter('all')
      const nextSeatInfo = extractSeats(nextElements)
      lastSeatsKeyRef.current = seatsKeyOf(nextSeatInfo)
      setSeatInfo(nextSeatInfo)
      const nextPlaced = extractPlacedResults(nextElements)
      lastPlacedKeyRef.current = nextPlaced.join('|')
      setPlacedResultIds(new Set(nextPlaced))
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
      else void window.flyingdraws.listBoards().then((list) => setBoards(list.boards))
      if (res.hubState) {
        lastInbox.current = res.hubState.inbox
        hadHandoff.current = Boolean(res.hubState.handoff)
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
    const epoch = sceneEpoch.current
    try {
      const json = serializeAsJSON(unmaskElements(elements, hiddenStateRef.current), appState, files, 'local')
      const res = await window.flyingdraws.saveBoard(json, boardIdRef.current ?? undefined)
      // 存的过程中画布已经换成另一块画板：这次的结果和现在的画面无关，不动它的保存状态
      if (epoch !== sceneEpoch.current) return
      if (res.skipped) {
        // 画板在存盘途中被改了名（内容没换）：等页面拿到新名字后再存一次
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => void save(), SAVE_DELAY_MS)
        return
      }
      lastSavedVersion.current = elementsVersion(elements)
      setStatus({ kind: 'saved', path: res.path, version: res.version, savedAt: res.savedAt })
    } catch (err) {
      setStatus({ kind: 'error', message: String(err) })
    }
  }, [])

  // 自己接管「打开」和拖入 .excalidraw：先过 sanitizeScene 再进画布（CVE-2026-97224），
  // 不让 Excalidraw 自带的导入把 generationData 先渲染一遍。
  const importSceneFile = useCallback(async (file: File) => {
    const current = apiRef.current
    if (!current) return
    const hasContent = current.getSceneElements().length > 0
    if (hasContent && !window.confirm('打开文件会替换当前画布内容，继续吗？')) return
    try {
      const data = await loadFromBlob(file, null, null)
      const { scene, stripped } = sanitizeScene(data)
      if (scene.files && Object.keys(scene.files).length > 0) {
        current.addFiles(Object.values(scene.files))
      }
      const { viewBackgroundColor, theme, gridModeEnabled, name } = scene.appState
      current.updateScene({
        elements: scene.elements,
        appState: { viewBackgroundColor: paperOr(viewBackgroundColor), theme, gridModeEnabled, name },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY
      })
      current.scrollToContent(undefined, { fitToContent: true })
      if (stripped > 0) setToast('已移除文件里一段可执行的嵌入内容（CVE-2026-97224）')
    } catch (err) {
      setToast(`打开失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])
  const isSceneFile = (file: File): boolean =>
    /\.excalidraw$/i.test(file.name) || file.type === 'application/vnd.excalidraw+json' || /\.json$/i.test(file.name)
  const openSceneFile = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.excalidraw,.json,application/json,application/vnd.excalidraw+json'
    input.onchange = () => {
      const file = input.files?.[0]
      if (file) void importSceneFile(file)
    }
    input.click()
  }, [importSceneFile])
  useEffect(() => {
    // 自带的 loadScene 动作已在 UIOptions 里关掉，Ctrl/Cmd+O 改走自己的打开
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        openSceneFile()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openSceneFile])
  const onCanvasDropCapture = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const file = e.dataTransfer?.files?.[0]
      if (!file || !isSceneFile(file)) return // 图片、素材库等交回 Excalidraw
      e.preventDefault()
      e.stopPropagation()
      void importSceneFile(file)
    },
    [importSceneFile]
  )

  const onChange = useCallback<OnChange>(
    (elements, appState, files) => {
      // 横幅和弹窗画在 Excalidraw 外面，要自己跟着它的深浅色走
      if (document.documentElement.dataset.fdTheme !== appState.theme) {
        document.documentElement.dataset.fdTheme = appState.theme
        window.flyingdraws.setTheme(appState.theme === 'dark' ? 'dark' : 'light')
      }
      // 兜底：「打开」菜单、拖入文件、粘贴、素材插入都走 Excalidraw 自己的导入，
      // 进来的 iframe 元素可能带 customData.generationData.html（CVE-2026-97224），
      // 在它的 srcdoc 加载之前（微任务里）就把字段剥掉。
      if (elements !== prevElementsRef.current && elements.some(hasUnsafeCustomData)) {
        const current = apiRef.current
        if (current) {
          queueMicrotask(() => {
            const live = current.getSceneElementsIncludingDeleted()
            if (!live.some(hasUnsafeCustomData)) return
            current.updateScene({
              elements: live.map((el) =>
                hasUnsafeCustomData(el) ? newElementWith(el, { customData: sanitizeElement(el).customData } as Parameters<typeof newElementWith>[1]) : el
              ),
              captureUpdate: CaptureUpdateAction.NEVER
            })
            setToast('已移除文件里一段可执行的嵌入内容（CVE-2026-97224）')
          })
        }
      }
      latest.current = [elements, appState, files]
      const elementsChanged = elements !== prevElementsRef.current
      const selectionChanged = appState.selectedElementIds !== prevSelectedIdsRef.current
      prevElementsRef.current = elements
      prevSelectedIdsRef.current = appState.selectedElementIds

      // 选区或元素引用变了才重算选中数与选中图片（平移、缩放、悬停移动直接跳过）
      if (elementsChanged || selectionChanged) {
        const picked = Object.keys(appState.selectedElementIds).filter((id) => appState.selectedElementIds[id])
        if (picked.length !== selectedCountRef.current) {
          selectedCountRef.current = picked.length
          setSelectedCount(picked.length)
        }
        const pickedImage =
          picked.length === 1 ? (elements.find((el) => el.id === picked[0] && el.type === 'image' && !el.isDeleted)?.id ?? null) : null
        if (pickedImage !== selectedImageRef.current) {
          selectedImageRef.current = pickedImage
          setSelectedImage(pickedImage)
        }
      }
      if (!elementsChanged) return

      const nextSeatInfo = extractSeats(elements)
      const nextSeatsKey = seatsKeyOf(nextSeatInfo)
      if (nextSeatsKey !== lastSeatsKeyRef.current) {
        lastSeatsKeyRef.current = nextSeatsKey
        setSeatInfo(nextSeatInfo)
      }
      const nextPlaced = extractPlacedResults(elements)
      const nextPlacedKey = nextPlaced.join('|')
      if (nextPlacedKey !== lastPlacedKeyRef.current) {
        lastPlacedKeyRef.current = nextPlacedKey
        setPlacedResultIds(new Set(nextPlaced))
      }
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
    const off = window.flyingdraws.onHubState(setHub)
    void window.flyingdraws.getHubState().then(setHub)
    return off
  }, [])

  // 处理主进程发来的调用。画布 API 准备好以后才通知主进程"页面就绪"
  useEffect(() => {
    if (!api) return
    const off = window.flyingdraws.onRpc(async ({ id, method, params }) => {
      const current = apiRef.current
      try {
        if (!current) throw new Error('canvas is not ready')
        if (method === 'snapshot') {
          const withImage = Boolean((params as { image?: boolean })?.image)
          const snap = await snapshot(current, withImage, hiddenStateRef.current)
          window.flyingdraws.rpcReply(id, { ...snap, board: boardIdRef.current ?? undefined })
        } else if (method === 'applyPlan') {
          const { plan, proposalId, agent, seat, color } = params as {
            plan: DrawPlan
            proposalId: string | null
            agent?: string | null
            seat?: boolean
            color?: string | null
          }
          const agentName = typeof agent === 'string' && agent.trim() ? agent.trim() : null
          if (agentName) primaryAgentRef.current = agentName
          window.flyingdraws.rpcReply(
            id,
            await applyPlan(
              current,
              plan,
              proposalId,
              agentName,
              Boolean(seat),
              color ?? null,
              hiddenStateRef.current,
              filterRef.current,
              primaryAgentRef.current,
              setDeferredDraw
            )
          )
        } else if (method === 'loadScene') {
          const next = params as { board: string; title: string | null; version: number; json: string | null }
          applyLoadedScene(current, next)
          window.flyingdraws.rpcReply(id, { ok: true })
        } else if (method === 'syncBoards') {
          const next = params as {
            board: string
            title: string | null
            version: number
            boards: BoardSummary[]
            hubState: HubState
          }
          boardIdRef.current = next.board
          setBoardInfo({ board: next.board, title: next.title })
          setBoards(next.boards)
          lastInbox.current = next.hubState.inbox
          setHub(next.hubState)
          setStatus((prev) =>
            prev.kind === 'saved' ? { ...prev, version: next.version, savedAt: new Date().toISOString() } : prev
          )
          window.flyingdraws.rpcReply(id, { ok: true })
        } else {
          throw new Error(`unknown method ${method}`)
        }
      } catch (err) {
        window.flyingdraws.rpcReply(id, null, err instanceof Error ? err.message : String(err))
      }
    })
    window.flyingdraws.ready()
    return off
  }, [api, applyLoadedScene])

  const handleSwitchBoard = useCallback(
    async (targetBoard: string) => {
      const current = apiRef.current
      if (!current || targetBoard === boardInfo.board) return
      try {
        const snap = await snapshot(current, false, hiddenStateRef.current)
        const res = await window.flyingdraws.switchBoard({ board: targetBoard, currentSceneJson: snap.sceneJson })
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
      const snap = await snapshot(current, false, hiddenStateRef.current)
      const res = await window.flyingdraws.createBoard({
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
    const snap = await snapshot(current, false, hiddenStateRef.current)
    const res = await window.flyingdraws.renameBoard({
      board: boardInfo.board,
      name: trimmed,
      title: /\s/.test(trimmed) ? trimmed : null,
      currentSceneJson: snap.sceneJson
    })
    boardIdRef.current = res.board
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
    const snap = await snapshot(current, false, hiddenStateRef.current)
    const target = boardInfo.board
    const res = await window.flyingdraws.deleteBoard({
      board: target,
      currentSceneJson: snap.sceneJson
    })
    applyLoadedScene(current, res)
    setConfirmDelete(false)
    setToast(`已删除画板「${res.deleted ?? target}」`)
  }, [applyLoadedScene, boardInfo.board])

  const submit = useCallback(
    async (requestId: string | null, note: string, to: string | null = null) => {
      if (!apiRef.current) return
      const targetBoard = boardIdRef.current ?? undefined
      const snap = await snapshot(apiRef.current, true, hiddenStateRef.current)
      // 有 agent 正等着（或者这是在回应它的请求）时，画会直接交到它手上；否则先放进收件箱，
      // 主进程同时把一句取画的话放进剪贴板
      const res = await window.flyingdraws.submit({ board: targetBoard, requestId, note, to, ...snap })
      if (res.delivered) setToast(`${to ?? 'agent'} 已经收到你的画`)
      else if (res.hint) setToast(`已复制一句话，去${to ? `「${to}」的` : ''}聊天里粘贴，它就会来取`)
      lastSavedVersion.current = elementsVersion(apiRef.current.getSceneElements())
      setComposing(false)
    },
    []
  )

  // 回应 agent 的提议：先把提议层上的元素合并或删掉，再把结果发给 agent
  const decide = useCallback(async (requestId: string, proposalId: string, accept: boolean, note: string, pending?: unknown) => {
    const current = apiRef.current
    if (!current) return
    const targetBoard = boardIdRef.current ?? undefined
    const skipped = resolveProposal(current, proposalId, accept, (pending as PendingChanges | null | undefined) ?? null, hiddenStateRef.current)
    if (filterRef.current !== 'all') {
      applyAuthorFilter(current, filterRef.current, hiddenStateRef.current, primaryAgentRef.current, isDynamicSeats(seatInfoRef.current))
    }
    const snap = await snapshot(current, true, hiddenStateRef.current)
    await window.flyingdraws.submit({ board: targetBoard, requestId, note, decision: accept ? 'accepted' : 'rejected', skipped, ...snap })
    lastSavedVersion.current = elementsVersion(current.getSceneElements())
  }, [])

  const selectFilter = useCallback((next: AuthorFilter) => {
    const target: AuthorFilter = next !== 'all' && filterRef.current === next ? 'all' : next
    filterRef.current = target
    setFilter(target)
    if (apiRef.current) {
      applyAuthorFilter(apiRef.current, target, hiddenStateRef.current, primaryAgentRef.current, isDynamicSeats(seatInfoRef.current))
    }
  }, [])

  // Ctrl+Shift+Enter：打开「发给 agent」；已经打开就直接发出去。
  // agent 的请求或提议正挂着时不替用户表态，只把光标放进那个横幅的附言框。
  const composingRef = useRef(composing)
  composingRef.current = composing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !e.shiftKey || !(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      e.stopPropagation()
      if (hubRef.current.pending.length) {
        document.querySelector<HTMLInputElement>('.fd-banner-note')?.focus()
      } else if (composingRef.current) {
        document.querySelector<HTMLButtonElement>('.fd-banner .fd-banner-actions .fd-primary')?.click()
      } else {
        setComposing(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
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
      const mine = api.getSceneElements().filter((el) => el.customData?.flyingdraws?.proposal === proposalId)
      if (!mine.length && ++tries < 20) return
      clearInterval(timer)
      showElements(api, mine, true)
    }, 250)
    return () => clearInterval(timer)
  }, [api, requestId, proposalId])

  // 端到端测试要直接操作画布（模拟用户拖动、改字），只在隔离的测试实例上开放
  useEffect(() => {
    if (api && window.flyingdraws.testMode) (window as unknown as { __flyingdrawsApi?: Api }).__flyingdrawsApi = api
  }, [api])

  const nextBoardName = () => {
    const used = new Set(boards.map((b) => b.board))
    for (let i = 1; ; i++) {
      const candidate = `board-${i}`
      if (!used.has(candidate)) return candidate
    }
  }

  const onlineSeats = hub.onlineSeats ?? []
  // 点选的席位中途离场了就退回「所有 agent」
  const sendTarget = sendTo && onlineSeats.some((s) => s.name === sendTo) ? sendTo : null
  const sendTargetWaiting = sendTarget ? onlineSeats.some((s) => s.name === sendTarget && s.waiting) : hub.agentWaiting
  const sendTargetName = sendTarget ?? 'agent'

  return (
    <>
      {/* 自己画的标题栏：和画布一个颜色，整条可以拖动窗口 */}
      <div className="fd-titlebar">
        <span className="fd-titlebar-app">Flying draws</span>
        {/* 画板切换、新建、「⋯」菜单和保存状态都在标题栏里，画布右上角只留「发给 agent」 */}
        <div className="fd-status fd-titlebar-tools">
          <select
            className="fd-board-select"
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
            className="fd-icon fd-new-board"
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
                onSelect: () => void window.flyingdraws.revealBoard()
              },
              {
                label: '重新加载',
                title: '重新载入页面（没存盘的修改会先保存）',
                sepBefore: true,
                onSelect: () => void save().then(() => window.flyingdraws.reloadWindow())
              },
              { label: '开发者工具', title: '打开或关闭开发者工具', onSelect: () => window.flyingdraws.toggleDevTools() },
              {
                sepBefore: true,
                label: '删除',
                title: boards.length <= 1 ? '至少保留一块画板' : '删除当前画板',
                danger: true,
                disabled: boards.length <= 1,
                onSelect: () => setConfirmDelete(true)
              }
            ]}
          />
          <StatusText status={status} />
          <button className={agentOpen ? 'fd-primary' : undefined} onClick={() => setAgentOpen(value => !value)} aria-expanded={agentOpen}>内置 Agent</button>
          {dock.docked ? (
            <button
              type="button"
              className="fd-dock-pill"
              title={`画布贴在「${dock.title ?? '另一个窗口'}」${dock.side === 'left' ? '左' : '右'}边，会跟着它移动和缩放。点一下解除，或者直接把画布拖开`}
              onClick={() => window.flyingdraws.releaseDock()}
            >
              已吸附 ×
            </button>
          ) : null}
        </div>
        <div className="fd-seats" aria-label="在线 agent 席位">
          {onlineSeats.length ? (
            <>
              <span className="fd-seats-label">在线</span>
              {onlineSeats.map((s) => {
                const canFilter = s.drawn && isDynamicSeats(seatInfo) && seatInfo.seats.some((item) => item.name === s.name)
                const active = canFilter && filter === `seat:${s.name}`
                const title = [
                  `席位：${s.name}`,
                  s.waiting ? '正在等待你的画' : '已接入',
                  canFilter ? '点击筛选该席位元素' : s.drawn ? '当前画板已落笔' : '当前画板尚未落笔'
                ].join(' · ')
                return (
                  <button
                    key={s.name}
                    type="button"
                    className={`fd-seat-pill${s.waiting ? ' fd-seat-pill-waiting' : ''}${active ? ' fd-seat-pill-active' : ''}`}
                    title={title}
                    disabled={!canFilter}
                    onClick={() => canFilter && selectFilter(`seat:${s.name}`)}
                  >
                    <span className="fd-seat-dot" style={{ background: s.color }} />
                    <span className="fd-seat-name">{s.name}</span>
                    {s.waiting ? <span className="fd-seat-badge">等待中</span> : null}
                  </button>
                )
              })}
            </>
          ) : (
            <span className="fd-seats-empty">暂无 agent 接入</span>
          )}
        </div>
      </div>
      <div className="fd-workspace">
      <div onDropCapture={onCanvasDropCapture} className={`fd-canvas${request || composing || hub.agentWaiting || hub.handoff || hub.inbox > 0 || deferredDraw ? ' fd-has-notice' : ''}`}>
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData}
        onChange={onChange}
        langCode="zh-CN"
        UIOptions={EXCALIDRAW_UI_OPTIONS}
        libraryReturnUrl={LIBRARY_CALLBACK_URL}
        renderTopRightUI={() => (
          <div className="fd-status">
            <button className="fd-primary" onClick={() => setComposing(true)} title="把当前画布发给 agent（Ctrl+Shift+Enter）">
              发给 agent
            </button>
          </div>
        )}
      >
        <MainMenu>
          <MainMenu.Item onSelect={openSceneFile} shortcut="Ctrl+O">
            打开
          </MainMenu.Item>
          <MainMenu.DefaultItems.SaveToActiveFile />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
      {request && request.kind === 'proposal' && request.proposalId ? (
        <Banner
          key={request.id}
          title="agent 画了它的理解（虚线半透明部分），可以直接在上面改："
          prompt={request.prompt}
          queued={queued}
          onSend={(note) => decide(request.id, request.proposalId!, true, note, request.pending)}
          sendLabel="对，就这样"
          onCancel={(note) => decide(request.id, request.proposalId!, false, note, request.pending)}
          cancelLabel="不对，去掉"
        />
      ) : request ? (
        <Banner
          key={request.id}
          title="agent 请你画："
          prompt={request.prompt}
          queued={queued}
          onSend={(note) => submit(request.id, note)}
          onCancel={() => void window.flyingdraws.cancel(request.id)}
          cancelLabel="不画了"
        />
      ) : composing ? (
        <Banner
          title="把当前画布发给 agent"
          prompt={
            sendTargetWaiting
              ? `${sendTargetName} 正在等你的画，发出后它马上就能看到。`
              : `${sendTargetName} 现在没在等。发出后会复制一句话到剪贴板，去它的聊天里粘贴一下，它才会来取。`
          }
          onSend={(note) => submit(null, note, sendTarget)}
          onCancel={() => setComposing(false)}
          cancelLabel="取消"
          keyboard
        >
          {/* 只有一个 agent 时不用选；两个以上才问发给谁 */}
          {onlineSeats.length > 1 ? (
            <div className="fd-send-to" role="radiogroup" aria-label="发给谁">
              <button type="button" role="radio" aria-checked={!sendTarget} className={!sendTarget ? 'fd-send-to-active' : undefined} onClick={() => setSendTo(null)}>
                所有 agent
              </button>
              {onlineSeats.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  role="radio"
                  aria-checked={sendTarget === s.name}
                  className={sendTarget === s.name ? 'fd-send-to-active' : undefined}
                  title={s.waiting ? '正在等你的画' : '没在等，发出后要去它的聊天里说一声'}
                  onClick={() => setSendTo(s.name)}
                >
                  <span className="fd-seat-dot" style={{ background: s.color }} />
                  {`@${s.name}`}
                  {s.waiting ? <span className="fd-seat-badge">等待中</span> : null}
                </button>
              ))}
            </div>
          ) : null}
        </Banner>
      ) : hub.agentWaiting ? (
        <div className="fd-waiting fd-waiting-live">
          agent 正在等你{hub.waitingAgents?.length ? `（${hub.waitingAgents.join('、')}）` : ''}：画好后点右上角「发给 agent」
        </div>
      ) : hub.handoff ? (
        <div className="fd-waiting">
          {hub.handoff.from} 把画笔递给了 {hub.handoff.to ?? '其他席位'}：「{hub.handoff.note}」
        </div>
      ) : hub.inbox > 0 ? (
        <div className="fd-waiting">
          已发出{hub.inbox > 1 ? ` ${hub.inbox} 份` : ''}，{hub.inboxTargets?.length ? hub.inboxTargets.join('、') : 'agent'} 还没来取。在聊天里跟它说一声「画好了」
          <button
            type="button"
            className="fd-waiting-action"
            title="把那句取画的话再复制一次，粘贴到 agent 的聊天里"
            onClick={() => void window.flyingdraws.copyHint().then((hint) => hint && setToast('已复制，去聊天里粘贴'))}
          >
            复制这句话
          </button>
        </div>
      ) : null}
      {deferredDraw ? (
        <div className="fd-waiting fd-waiting-live fd-deferred-draw" role="status" aria-live="polite">
          {deferredDraw.agent ?? 'Agent'} 有内容要画，{deferredDraw.editingText ? '结束文字编辑' : '松笔'}后更新
        </div>
      ) : null}
      {toast ? (
        <button type="button" className="fd-toast" role="status" title="点一下收起" onClick={() => setToast(null)}>
          {toast}
        </button>
      ) : null}
      <div className="fd-filter" role="tablist" aria-label="按作者筛选显示">
        {isDynamicSeats(seatInfo) ? (
          <>
            <button role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'fd-filter-active' : undefined} onClick={() => selectFilter('all')}>
              全部
            </button>
            <button role="tab" aria-selected={filter === 'user'} className={filter === 'user' ? 'fd-filter-active' : undefined} onClick={() => selectFilter('user')}>
              我画的
            </button>
            {seatInfo.seats.map((s) => {
              const key: AuthorFilter = `seat:${s.name}`
              return (
                <button
                  key={s.name}
                  role="tab"
                  aria-selected={filter === key}
                  className={filter === key ? 'fd-filter-active' : undefined}
                  onClick={() => selectFilter(key)}
                >
                  <span className="fd-seat-dot" style={{ background: s.color }} />
                  {s.name}
                </button>
              )
            })}
            {seatInfo.hasAnonAgent ? (
              <button
                role="tab"
                aria-selected={filter === 'agent'}
                className={filter === 'agent' ? 'fd-filter-active' : undefined}
                onClick={() => selectFilter('agent')}
              >
                agent 画的
              </button>
            ) : null}
          </>
        ) : (
          (
            [
              ['all', '全部'],
              ['user', '我画的'],
              ['agent', 'agent 画的'],
              ['other', '其他 agent']
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={filter === key}
              className={filter === key ? 'fd-filter-active' : undefined}
              onClick={() => selectFilter(key)}
            >
              {label}
            </button>
          ))
        )}
      </div>
      </div>
      <AgentPanel
        open={agentOpen}
        board={boardInfo.board}
        onClose={() => setAgentOpen(false)}
        selectedCount={selectedCount}
        placedImageIds={placedResultIds}
        onClearSelection={() => {
          const current = apiRef.current
          if (!current) return
          current.updateScene({ appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.NEVER })
        }}
        insertImage={(image, dataURL, opts) => {
          const runInsert = async () => {
            const current = apiRef.current
            const targetBoard = boardIdRef.current
            if (!current) {
              if (opts?.auto) return
              throw new Error('画布还没准备好')
            }
            if (opts?.auto) {
              const startedAt = Date.now()
              const deadline = startedAt + USER_BUSY_WAIT_MS
              let notified = false
              try {
                while (userIsBusy(current)) {
                  if (apiRef.current !== current || boardIdRef.current !== targetBoard) return
                  if (Date.now() > deadline) {
                    setToast('结果图片已就绪，可在侧栏点击「放到画布」加入演进链')
                    return
                  }
                  if (!notified && Date.now() - startedAt >= DEFERRED_NOTICE_MS) {
                    notified = true
                    setDeferredDraw({ agent: AGENT_SEAT, editingText: Boolean(current.getAppState().editingTextElement) })
                  }
                  await sleep(100)
                }
              } finally {
                if (notified) setDeferredDraw(null)
              }
            } else if (userIsBusy(current)) {
              throw new Error('请先完成当前绘制或编辑')
            }

            const bitmap = new Image()
            bitmap.src = dataURL
            await bitmap.decode()
            if (apiRef.current !== current || boardIdRef.current !== targetBoard) {
              if (opts?.auto) return
              throw new Error('画板已切换，请回到原画板再放入图片')
            }

            const natW = bitmap.naturalWidth > 0 ? bitmap.naturalWidth : (image.meta?.naturalWidth || 640)
            const natH = bitmap.naturalHeight > 0 ? bitmap.naturalHeight : (image.meta?.naturalHeight || 480)
            const { w, h } = displaySizeForImage(natW, natH)
            const elements = unmaskElements(current.getSceneElementsIncludingDeleted(), hiddenStateRef.current)
            const view = visibleArea(current.getAppState())
            const plan = planImageLineage({
              elements: elements as unknown as LineageCanvasElement[],
              image,
              size: { w, h },
              naturalSize: { w: natW, h: natH },
              view,
              ...(opts?.annotations?.length ? { annotations: opts.annotations } : {})
            })

            if (plan.alreadyPlaced) {
              if (!opts?.auto && plan.existingElementId) {
                const targetEl = current.getSceneElements().find((el) => el.id === plan.existingElementId && el.opacity > 0)
                if (targetEl) showElements(current, [targetEl], false)
                setToast('该结果图片已在画布演进链中')
              }
              return
            }

            type ImageEl = Extract<SceneEl, { type: 'image' }>
            const fileId = image.id as NonNullable<ImageEl['fileId']>
            current.addFiles([{ id: fileId, dataURL: dataURL as Parameters<Api['addFiles']>[0][number]['dataURL'], mimeType: image.mediaType, created: Date.now() }])

            const skeletons: Record<string, unknown>[] = [
              {
                type: 'image',
                id: plan.imageId,
                fileId,
                x: plan.x,
                y: plan.y,
                width: plan.w,
                height: plan.h
              }
            ]
            if (plan.edge) {
              skeletons.push({
                type: 'arrow',
                id: plan.edge.id,
                x: plan.edge.x,
                y: plan.edge.y,
                width: Math.abs(plan.edge.points[1][0]),
                height: Math.abs(plan.edge.points[1][1]),
                points: plan.edge.points,
                endArrowhead: 'arrow',
                label: { text: plan.edge.label, fontSize: 14 }
              })
            }
            // 改前圈选位置投到改后截图上：红色虚线框 + 编号，只是对照用，不进语义层
            for (const overlay of plan.overlays) {
              skeletons.push({ type: 'rectangle', id: overlay.id, x: overlay.x, y: overlay.y, width: overlay.w, height: overlay.h })
              skeletons.push({ type: 'text', id: `${overlay.id}_lbl`, x: overlay.x, y: Math.max(plan.y, overlay.y - 20), text: overlay.label, fontSize: 14 })
            }
            const overlayIds = new Set(plan.overlays.flatMap((o) => [o.id, `${o.id}_lbl`]))
            if (plan.caption) {
              skeletons.push({
                type: 'text',
                id: plan.caption.id,
                x: plan.caption.x,
                y: plan.caption.y,
                text: plan.caption.text,
                fontSize: plan.caption.fontSize
              })
            }

            const baseMark = {
              author: 'agent',
              agent: AGENT_SEAT,
              seat: true,
              layer: 'final'
            }
            const created = convertToExcalidrawElements(skeletons as unknown as SkeletonList, { regenerateIds: false })
            const added = created.map((el) => {
              if (el.type === 'image') {
                const bound = plan.edge
                  ? [...(el.boundElements ?? []), { id: plan.edge.id, type: 'arrow' as const }]
                  : el.boundElements
                return {
                  ...el,
                  ...(bound ? { boundElements: bound } : {}),
                  customData: {
                    ...el.customData,
                    flyingdraws: {
                      ...baseMark,
                      result: image.id,
                      lineageVersion: plan.versionNumber,
                      imageMeta: {
                        ...image.meta,
                        naturalWidth: natW,
                        naturalHeight: natH
                      }
                    }
                  }
                } as SceneEl
              }
              if (overlayIds.has(el.id)) {
                return {
                  ...el,
                  strokeColor: '#e03131',
                  backgroundColor: 'transparent',
                  strokeStyle: el.type === 'text' ? el.strokeStyle : 'dashed',
                  opacity: 85,
                  customData: { ...el.customData, flyingdraws: { ...baseMark, role: 'compare-overlay', lineageRole: 'compare-overlay' } }
                } as SceneEl
              }
              if (el.type === 'arrow' && plan.edge && el.id === plan.edge.id) {
                return {
                  ...el,
                  strokeColor: AGENT_COLOR,
                  startBinding: { elementId: plan.edge.fromId, focus: 0, gap: 8 },
                  endBinding: { elementId: plan.edge.toId, focus: 0, gap: 8 },
                  customData: {
                    ...el.customData,
                    flyingdraws: {
                      ...baseMark,
                      lineageRole: 'edge'
                    }
                  }
                } as SceneEl
              }
              return {
                ...el,
                strokeColor: AGENT_COLOR,
                customData: {
                  ...el.customData,
                  flyingdraws: {
                    ...baseMark,
                    lineageRole: (el as Loose).containerId ? 'edge-label' : 'caption'
                  }
                }
              } as SceneEl
            })

            const updatedExisting =
              plan.parentId && plan.edge
                ? elements.map((el) => {
                    if (el.id !== plan.parentId) return el
                    const prevBound = el.boundElements ?? []
                    if (prevBound.some((b) => b.id === plan.edge!.id)) return el
                    return newElementWith(el, {
                      boundElements: [...prevBound, { id: plan.edge!.id, type: 'arrow' }]
                    })
                  })
                : elements

            const nextAll = [...updatedExisting, ...added]
            current.updateScene({ elements: nextAll, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
            const nextPlaced = extractPlacedResults(nextAll)
            lastPlacedKeyRef.current = nextPlaced.join('|')
            setPlacedResultIds(new Set(nextPlaced))
            if (filterRef.current !== 'all') {
              applyAuthorFilter(current, filterRef.current, hiddenStateRef.current, primaryAgentRef.current, isDynamicSeats(extractSeats(nextAll)))
            }
            const addedIds = new Set(added.map((a) => a.id))
            // 父图（圈选原图）和新图一起进视野，方便并排对照
            if (plan.parentId) addedIds.add(plan.parentId)
            const visibleAdded = current.getSceneElements().filter((el) => addedIds.has(el.id) && el.opacity > 0)
            showElements(current, visibleAdded, false)
            setToast(
              plan.parentId
                ? `已连入视觉演进链（v${plan.versionNumber}），可继续圈选批注`
                : '结果图片已放到画布，可直接圈选批注'
            )
          }
          const next = insertQueueRef.current.then(runInsert, runInsert)
          insertQueueRef.current = next.catch(() => undefined)
          return next
        }}
        capture={async () => {
          const current = apiRef.current
          if (!current) throw new Error('画布还没准备好')
          const snap = await snapshot(current, true, hiddenStateRef.current, true)
          return { sceneJson: snap.sceneJson, pngBase64: snap.pngBase64, selectedIds: snap.selectedIds }
        }}
        selectedImage={selectedImage}
        traceCapture={async () => {
          const current = apiRef.current
          const targetBoard = boardIdRef.current
          const imageId = selectedImageRef.current
          if (!current) throw new Error('画布还没准备好')
          if (!imageId) throw new Error('先在画布上选中一张图片')
          // 交给模型的是原图本身，不是缩在画布上的截图；坐标系用实际发出去的那张图的尺寸
          const source = await originalImage(current, imageId)
          if (apiRef.current !== current || boardIdRef.current !== targetBoard) throw new Error('画板已切换，请重新选择图片')
          const snap = await snapshot(current, false, hiddenStateRef.current, true, new Set([imageId]))
          return { imageId, width: source.width, height: source.height, capture: { sceneJson: snap.sceneJson, pngBase64: source.base64, selectedIds: [imageId] } }
        }}
      />
      </div>
      {api ? <StrokeWidthSlider api={api} /> : null}
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
    <div className="fd-modal-backdrop" onClick={() => !busy && props.onClose()}>
      <div className="fd-modal" role="dialog" aria-label={props.modeTitle} onClick={(e) => e.stopPropagation()}>
        <div className="fd-modal-title">{props.modeTitle}</div>
        <input
          autoFocus
          value={name}
          placeholder="例如：login-flow 或 登录流程"
          onFocus={(e) => e.target.select()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter' && !busy) void submit()
            if (e.key === 'Escape' && !busy) props.onClose()
          }}
        />
        {error ? <div className="fd-error">{error}</div> : null}
        <div className="fd-modal-actions">
          <button onClick={props.onClose} disabled={busy}>
            取消
          </button>
          <button className="fd-primary" onClick={() => void submit()} disabled={busy}>
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
    <div className="fd-modal-backdrop" onClick={() => !busy && props.onClose()}>
      <div
        className="fd-modal"
        role="dialog"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' && !busy) props.onClose()
        }}
      >
        <div className="fd-modal-title">{props.title}</div>
        <div>{props.message}</div>
        {error ? <div className="fd-error">{error}</div> : null}
        <div className="fd-modal-actions">
          <button autoFocus onClick={props.onClose} disabled={busy}>
            取消
          </button>
          <button className="fd-danger" onClick={() => void confirm()} disabled={busy}>
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
  children?: ReactNode // 提示语和附言之间的额外内容，比如点选发给哪个席位
  keyboard?: boolean // 用户自己打开的横幅：一出来就把光标放进附言框，Enter 发送、Esc 取消
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
    <div
      className="fd-banner"
      role="dialog"
      aria-label={props.title}
      onKeyDown={(e) => {
        if (props.keyboard && e.key === 'Escape' && !sending) {
          e.stopPropagation()
          void run(props.onCancel)
        }
      }}
    >
      <div className="fd-banner-title">{props.title}</div>
      <div className="fd-banner-prompt">{props.prompt}</div>
      {props.queued ? <div className="fd-banner-queued">处理完这个，后面还有 {props.queued} 个请求</div> : null}
      {props.children}
      <input
        className="fd-banner-note"
        placeholder={props.keyboard ? '想补充一句话吗？（可不填，Enter 发送，Esc 取消）' : '想补充一句话吗？（可不填）'}
        autoFocus={props.keyboard}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation() // 别让 Excalidraw 把输入当成快捷键
          if (e.nativeEvent.isComposing || e.keyCode === 229) return
          if (e.key === 'Enter' && !sending) void send()
          // 上面拦住了冒泡，横幅外层收不到这次按键，Esc 要在这里自己处理
          else if (e.key === 'Escape' && props.keyboard && !sending) void run(props.onCancel)
        }}
      />
      {error ? <div className="fd-error">{error}</div> : null}
      <div className="fd-banner-actions">
        <button onClick={() => void run(props.onCancel)} disabled={sending}>
          {props.cancelLabel}
        </button>
        <button className="fd-primary" onClick={() => void send()} disabled={sending}>
          {sending ? '发送中…' : (props.sendLabel ?? '发送')}
        </button>
      </div>
    </div>
  )
}

type MenuItem = { label: string; title?: string; danger?: boolean; disabled?: boolean; sepBefore?: boolean; onSelect: () => void }

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
    <div className="fd-more-wrap" ref={wrap}>
      <button
        className="fd-icon fd-more"
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
            <div className="fd-menu" role="menu" ref={menu} style={{ top: pos.top, right: pos.right }}>
              {items.flatMap((item) => [
                item.sepBefore ? <div key={`${item.label}-sep`} className="fd-menu-sep" role="separator" /> : null,
                <button
                  key={item.label}
                  role="menuitem"
                  className={item.danger ? 'fd-menu-danger' : undefined}
                  title={item.title}
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false)
                    item.onSelect()
                  }}
                >
                  {item.label}
                </button>
              ])}
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
      return <span className="fd-save">载入中…</span>
    case 'idle':
      return <span className="fd-save">未修改</span>
    case 'saved':
      return (
        <span
          className="fd-save fd-save-ok"
          title={`v${status.version} · ${new Date(status.savedAt).toLocaleTimeString()}\n${status.path}`}
        >
          已保存
        </span>
      )
    case 'error':
      return (
        <span className="fd-save fd-save-error" title={status.message}>
          出错了：{status.message}
        </span>
      )
  }
}
