import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// 字体从本地加载（scripts/copy-fonts.mjs 会把字体拷到 public/fonts），
// 不依赖 CDN，断网也能用。开发模式（http）和打包后（file://）都适用。
window.EXCALIDRAW_ASSET_PATH = new URL('./', window.location.href).href

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    delete document.documentElement.dataset.fdLoading
    console.error('[flying-draws] unhandled render error:', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        <h2>页面出现异常</h2>
        <p style={{ color: '#c92a2a', whiteSpace: 'pre-wrap' }}>{this.state.error.message || String(this.state.error)}</p>
        <button
          type="button"
          onClick={() => {
            if (window.flyingdraws?.reloadWindow) window.flyingdraws.reloadWindow()
            else window.location.reload()
          }}
        >
          重新加载
        </button>
      </div>
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
