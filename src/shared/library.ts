// 素材库 URL 识别与安全校验（纯函数，主进程与渲染层共用，无 Node / Electron 依赖）。

export const LIBRARY_CALLBACK_URL = 'https://flyingdraws.local/library-callback'
export const MAX_LIBRARY_BYTES = 8 * 1024 * 1024

export function isExcalidrawLibraryBrowseUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    return parsed.protocol === 'https:' && parsed.hostname === 'libraries.excalidraw.com'
  } catch {
    return false
  }
}

export function validateRemoteLibraryUrl(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('素材库地址格式无效')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('仅允许通过 HTTPS 获取官方素材库')
  }
  const host = parsed.hostname.toLowerCase()
  const allowedExcalidraw = host === 'excalidraw.com' || host.endsWith('.excalidraw.com')
  const allowedGithubRaw =
    host === 'raw.githubusercontent.com' && parsed.pathname.startsWith('/excalidraw/excalidraw-libraries/')
  if (!allowedExcalidraw && !allowedGithubRaw) {
    throw new Error(`不允许从未知域名加载素材库：${host}`)
  }
  if (!parsed.pathname.toLowerCase().endsWith('.excalidrawlib')) {
    throw new Error('素材库文件后缀必须为 .excalidrawlib')
  }
  return parsed.toString()
}

export function parseLibraryInstallNavigation(rawUrl: string): { libraryUrl: string; token: string | null } | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null

  const hashParams = parsed.hash.startsWith('#') ? new URLSearchParams(parsed.hash.slice(1)) : null
  const searchParams = parsed.search ? new URLSearchParams(parsed.search) : null
  const rawLibrary = hashParams?.get('addLibrary') ?? searchParams?.get('addLibrary') ?? null
  if (!rawLibrary) return null

  let decoded = rawLibrary
  try {
    decoded = decodeURIComponent(rawLibrary)
  } catch {
    // URLSearchParams 已解码过一次；若包含残余非法百分号编码保持原值交由 URL 校验拒绝
  }
  const libraryUrl = validateRemoteLibraryUrl(decoded)
  const token = hashParams?.get('token') ?? searchParams?.get('token') ?? null
  return { libraryUrl, token }
}
