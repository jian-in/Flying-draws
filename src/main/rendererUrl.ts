import { pathToFileURL } from 'node:url'

/** 页面地址是否就是本应用的渲染页：生产环境是打包里的 index.html，开发环境是 electron-vite 的 dev server。 */
export function isAppRendererUrl(rawUrl: string | undefined, rendererFile: string, devUrl?: string): boolean {
  if (!rawUrl) return false
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (devUrl) {
    try {
      const dev = new URL(devUrl)
      if ((dev.protocol === 'http:' || dev.protocol === 'https:') && url.origin === dev.origin) return true
    } catch {
      // dev 地址写坏了就只认打包页面
    }
  }
  if (url.protocol !== 'file:') return false
  const expected = pathToFileURL(rendererFile)
  // Windows 路径不分大小写，其他平台严格比较
  const same = process.platform === 'win32'
    ? url.pathname.toLowerCase() === expected.pathname.toLowerCase()
    : url.pathname === expected.pathname
  return same && url.host === expected.host
}
