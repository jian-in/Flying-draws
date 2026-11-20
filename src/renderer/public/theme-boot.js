// 主进程把上次的深浅色带在地址上（?theme=dark）。这个脚本在 <head> 里同步执行，
// 样式生效前就设好 data-fd-theme，深色用户启动时不先闪一下浅色。
// 单独成文件而不是内联：打包后的 CSP 只放行应用自身的脚本（script-src 'self'）。
// 同时标上 data-fd-loading：画板载入前 Excalidraw 会先按默认白底、浅色画一帧画布，先藏起来，
// 等 App.tsx 第一次收到 onChange（Excalidraw 载入完成后才会调）再放出来。
try {
  var fdTheme = new URLSearchParams(location.search).get('theme')
  if (fdTheme === 'dark' || fdTheme === 'light') document.documentElement.dataset.fdTheme = fdTheme
  document.documentElement.dataset.fdLoading = ''
} catch (e) {}
