import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// 字体从本地加载（scripts/copy-fonts.mjs 会把字体拷到 public/fonts），
// 不依赖 CDN，断网也能用。开发模式（http）和打包后（file://）都适用。
window.EXCALIDRAW_ASSET_PATH = new URL('./', window.location.href).href

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
