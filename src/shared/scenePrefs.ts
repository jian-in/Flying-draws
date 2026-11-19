// 画板里除了元素以外、也该随画板保存的几项画布设置。
// 只改这些（换背景色、开关网格）时元素版本不变，要单独认出来才会存盘。
// 深浅色不在这里：Excalidraw 导出 .excalidraw 时不写 theme，它作为应用级设置存在 state.json。
export function scenePrefsKey(appState: unknown): string {
  const s = (appState && typeof appState === 'object' ? appState : {}) as Record<string, unknown>
  return JSON.stringify([s.viewBackgroundColor ?? null, s.gridModeEnabled ?? null, s.gridSize ?? null, s.gridStep ?? null])
}
