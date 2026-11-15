export {}

declare global {
  interface Window {
    sketchlink: {
      loadBoard: () => Promise<{ json: string | null; path: string }>
      saveBoard: (json: string) => Promise<{ path: string; saveCount: number; savedAt: string }>
      revealBoard: () => Promise<void>
    }
    EXCALIDRAW_ASSET_PATH?: string
  }
}
