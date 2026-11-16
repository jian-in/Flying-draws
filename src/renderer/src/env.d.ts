export {}

declare global {
  interface HubState {
    pending: { id: string; kind: 'draw' | 'proposal'; proposalId: string | null; prompt: string; createdAt: string }[]
    agentWaiting: boolean
    inbox: number
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
  }

  interface Window {
    flyingdraws: {
      loadBoard: () => Promise<BoardLoadResult>
      listBoards: () => Promise<{ current: string; boards: BoardSummary[] }>
      saveBoard: (json: string) => Promise<{ board: string; path: string; saveCount: number; version: number; savedAt: string }>
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
      setTheme: (theme: 'light' | 'dark') => void
      reloadWindow: () => void
      toggleDevTools: () => void
      getHubState: () => Promise<HubState>
      onHubState: (fn: (state: HubState) => void) => () => void
      submit: (payload: {
        requestId: string | null
        note: string
        sceneJson: string
        pngBase64: string | null
        decision?: 'accepted' | 'rejected' | null
      }) => Promise<{ version: number }>
      cancel: (requestId: string) => Promise<boolean>
      onRpc: (fn: (msg: { id: number; method: string; params: unknown }) => void) => () => void
      rpcReply: (id: number, result: unknown, error?: string) => void
      ready: () => void
      testMode: boolean
    }
    EXCALIDRAW_ASSET_PATH?: string
  }
}
