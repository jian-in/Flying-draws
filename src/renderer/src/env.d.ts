export {}

declare global {
  interface HubState {
    pending: { id: string; kind: 'draw' | 'proposal'; proposalId: string | null; prompt: string; createdAt: string }[]
    agentWaiting: boolean
    inbox: number
  }

  interface Window {
    sketchlink: {
      loadBoard: () => Promise<{ json: string | null; path: string }>
      saveBoard: (json: string) => Promise<{ path: string; saveCount: number; version: number; savedAt: string }>
      revealBoard: () => Promise<void>
      getHubState: () => Promise<HubState>
      onHubState: (fn: (state: HubState) => void) => void
      submit: (payload: {
        requestId: string | null
        note: string
        sceneJson: string
        pngBase64: string | null
        decision?: 'accepted' | 'rejected' | null
      }) => Promise<{ version: number }>
      cancel: (requestId: string) => Promise<boolean>
      onRpc: (fn: (msg: { id: number; method: string; params: unknown }) => void) => void
      rpcReply: (id: number, result: unknown, error?: string) => void
      ready: () => void
      testMode: boolean
    }
    EXCALIDRAW_ASSET_PATH?: string
  }
}
