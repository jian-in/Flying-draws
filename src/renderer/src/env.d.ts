import type { AgentApi } from '../../shared/agent'
export {}

declare global {
  interface OnlineSeat {
    name: string
    color: string
    explicit: boolean
    waiting: boolean
    drawn: boolean
  }

  interface HubState {
    pending: { id: string; kind: 'draw' | 'proposal'; proposalId: string | null; pending?: unknown; prompt: string; createdAt: string }[]
    agentWaiting: boolean
    waitingAgents?: string[]
    inbox: number
    inboxTargets?: string[]
    handoff?: { from: string; to: string | null; note: string } | null
    onlineSeats?: OnlineSeat[]
  }

  interface DockState {
    docked: boolean
    side: 'left' | 'right' | null
    title: string | null
  }

  interface BoardSummary {
    board: string
    title: string | null
    version: number
    elements: number
    updatedAt: string
    active: boolean
  }

  interface BoardLoadResult {
    board: string
    title: string | null
    version: number
    json: string | null
    path: string
    boards: BoardSummary[]
    hubState?: HubState
    oldBoard?: string
    deleted?: string
    theme?: 'light' | 'dark'
  }

  interface Window {
    flyingdraws: {
      agent: AgentApi
      captureWindow?: () => Promise<string>
      loadBoard: () => Promise<BoardLoadResult>
      listBoards: () => Promise<{ current: string; boards: BoardSummary[] }>
      saveBoard: (
        json: string,
        board?: string
      ) => Promise<{ board: string; path: string; saveCount: number; version: number; savedAt: string; skipped?: boolean }>
      createBoard: (payload: { name: string; title?: string; currentSceneJson?: string }) => Promise<BoardLoadResult>
      switchBoard: (payload: { board: string; currentSceneJson?: string }) => Promise<BoardLoadResult>
      renameBoard: (payload: {
        board?: string
        name: string
        title?: string | null
        currentSceneJson?: string
      }) => Promise<BoardLoadResult>
      deleteBoard: (payload: { board: string; currentSceneJson?: string }) => Promise<BoardLoadResult>
      revealBoard: () => Promise<void>
      loadLibrary: () => Promise<{ libraryItems: unknown[] } | null>
      saveLibrary: (data: { libraryItems: readonly unknown[] }) => Promise<void>
      onLibraryInstall: (fn: (payload: { json?: string; itemCount?: number; error?: string }) => void) => () => void
      setTheme: (theme: 'light' | 'dark') => void
      reloadWindow: () => void
      toggleDevTools: () => void
      getHubState: () => Promise<HubState>
      onHubState: (fn: (state: HubState) => void) => () => void
      submit: (payload: {
        board?: string
        requestId: string | null
        note: string
        sceneJson: string
        pngBase64: string | null
        decision?: 'accepted' | 'rejected' | null
        skipped?: string[]
        to?: string | null
      }) => Promise<{ version: number; delivered: boolean; hint: string | null }>
      cancel: (requestId: string) => Promise<boolean>
      getDockState: () => Promise<DockState>
      onDockState: (fn: (state: DockState) => void) => () => void
      releaseDock: () => void
      copyHint: () => Promise<string | null>
      onRpc: (fn: (msg: { id: number; method: string; params: unknown }) => void) => () => void
      rpcReply: (id: number, result: unknown, error?: string) => void
      ready: () => void
      testMode: boolean
    }
    EXCALIDRAW_ASSET_PATH?: string
  }
}
