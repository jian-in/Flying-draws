import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// 打包后的页面加一条 CSP：脚本只能来自应用自身，外部页面和注入内容无法执行脚本。
// 开发模式不加（Vite 的 HMR 需要内联脚本和 websocket）。
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  // Excalidraw 会把 esm.sh 列为字体的备用来源；本地字体优先，放行它只是避免控制台刷屏，不影响离线使用
  "font-src 'self' data: blob: https://esm.sh",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "media-src 'self' data: blob: https:",
  "frame-src https:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'flying-draws-csp',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY }, injectTo: 'head-prepend' }
    ]
  }
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    publicDir: resolve(__dirname, 'src/renderer/public'),
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    },
    plugins: [react(), contentSecurityPolicy()]
  }
})
