// 窗口吸附：把画布窗口拖到别的窗口（比如 agent 的客户端）旁边松手，它就贴上去——
// 和那个窗口等高、顶边对齐、宽度占满那一侧剩下的屏幕，之后跟着那个窗口移动、缩放、回到前台。
// 再把画布拖开就解除。几何判断在 dockGeometry.ts，这里只管和系统窗口打交道。
// 目前只在 Windows 上生效（靠 user32 / dwmapi 读别的窗口的位置），其他系统上什么都不做。
import { screen, type BrowserWindow } from 'electron'
import koffi from 'koffi'
import { dockedRect, pickTarget, sameRect, snapSide, type DockSide, type Rect } from './dockGeometry'

export interface DockState {
  docked: boolean
  side: DockSide | null
  title: string | null // 贴着的那个窗口的标题
}

type Hwnd = number
type RawRect = { left: number; top: number; right: number; bottom: number }

interface Win32 {
  topWindow: () => Hwnd
  nextWindow: (h: Hwnd) => Hwnd
  foreground: () => Hwnd
  exists: (h: Hwnd) => boolean
  visible: (h: Hwnd) => boolean
  minimized: (h: Hwnd) => boolean
  cloaked: (h: Hwnd) => boolean
  exStyle: (h: Hwnd) => number
  pid: (h: Hwnd) => number
  title: (h: Hwnd) => string
  className: (h: Hwnd) => string
  frame: (h: Hwnd) => Rect | null // 看得见的那一圈
  outer: (h: Hwnd) => Rect | null // 系统记的窗口矩形，四周可能多出一圈看不见的拖拽边
}

function loadWin32(): Win32 | null {
  if (process.platform !== 'win32') return null
  try {
    const user32 = koffi.load('user32.dll')
    const dwmapi = koffi.load('dwmapi.dll')
    const RECT = koffi.struct('FD_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
    void RECT
    const GetTopWindow = user32.func('uintptr_t __stdcall GetTopWindow(uintptr_t h)')
    const GetWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t h, uint32_t cmd)')
    const GetForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()')
    const IsWindow = user32.func('int __stdcall IsWindow(uintptr_t h)')
    const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(uintptr_t h)')
    const IsIconic = user32.func('int __stdcall IsIconic(uintptr_t h)')
    const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(uintptr_t h, int index)')
    const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t h, _Out_ uint32_t *pid)')
    const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t h, _Out_ uint16_t *buf, int max)')
    const GetClassNameW = user32.func('int __stdcall GetClassNameW(uintptr_t h, _Out_ uint16_t *buf, int max)')
    const GetWindowRect = user32.func('int __stdcall GetWindowRect(uintptr_t h, _Out_ FD_RECT *rect)')
    const DwmGetRect = dwmapi.func('long __stdcall DwmGetWindowAttribute(uintptr_t h, uint32_t attr, _Out_ FD_RECT *out, uint32_t size)')
    const DwmGetInt = dwmapi.func('long __stdcall DwmGetWindowAttribute(uintptr_t h, uint32_t attr, _Out_ int *out, uint32_t size)')
    const GW_HWNDNEXT = 2
    const GWL_EXSTYLE = -20
    const DWMWA_EXTENDED_FRAME_BOUNDS = 9
    const DWMWA_CLOAKED = 14
    const text = (fn: (h: Hwnd, buf: Uint16Array, max: number) => number, h: Hwnd): string => {
      const buf = new Uint16Array(256)
      const n = fn(h, buf, 256)
      return n > 0 ? String.fromCharCode(...buf.subarray(0, n)) : ''
    }
    const toRect = (r: RawRect): Rect | null =>
      r.right > r.left && r.bottom > r.top ? { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top } : null
    return {
      topWindow: () => Number(GetTopWindow(0)),
      nextWindow: (h) => Number(GetWindow(h, GW_HWNDNEXT)),
      foreground: () => Number(GetForegroundWindow()),
      exists: (h) => Boolean(IsWindow(h)),
      visible: (h) => Boolean(IsWindowVisible(h)),
      minimized: (h) => Boolean(IsIconic(h)),
      cloaked: (h) => {
        const out = [0]
        return DwmGetInt(h, DWMWA_CLOAKED, out, 4) === 0 && out[0] !== 0
      },
      exStyle: (h) => Number(BigInt(GetWindowLongPtrW(h, GWL_EXSTYLE)) & 0xffffffffn),
      pid: (h) => {
        const out = [0]
        GetWindowThreadProcessId(h, out)
        return out[0]
      },
      title: (h) => text(GetWindowTextW, h),
      className: (h) => text(GetClassNameW, h),
      frame: (h) => {
        const r = {} as RawRect
        return DwmGetRect(h, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) === 0 ? toRect(r) : null
      },
      outer: (h) => {
        const r = {} as RawRect
        return GetWindowRect(h, r) ? toRect(r) : null
      }
    }
  } catch (err) {
    console.error('[flyingdraws] window docking is unavailable:', err)
    return null
  }
}

const WS_EX_TRANSPARENT = 0x20
const WS_EX_TOOLWINDOW = 0x80
const WS_EX_NOACTIVATE = 0x08000000
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'])
const FOLLOW_MS = 120
const OWN_MOVE_MS = 400 // 我们自己挪窗口后这么久之内收到的移动/缩放事件，不当成用户的操作

export class WindowDock {
  private api = loadWin32()
  private win: BrowserWindow
  private onState: (s: DockState) => void
  private target: { hwnd: Hwnd; side: DockSide; title: string; lastRect: Rect | null; width: number | null } | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private lastForeground: Hwnd = 0
  private ownMoveUntil = 0

  constructor(win: BrowserWindow, onState: (s: DockState) => void) {
    this.win = win
    this.onState = onState
    if (!this.api) return
    win.on('moved', () => this.userMoved())
    win.on('resized', () => this.userResized())
    win.on('closed', () => this.stop())
  }

  state(): DockState {
    return { docked: Boolean(this.target), side: this.target?.side ?? null, title: this.target?.title ?? null }
  }

  // 用户点了「解除吸附」
  release(): void {
    if (this.target) this.undock()
  }

  // 用户拖完画布松手：贴着别的窗口就吸上去，从吸着的窗口旁边拖开就解除
  userMoved(force = false): void {
    const api = this.api
    if (!api || this.win.isDestroyed()) return
    if (!force && Date.now() < this.ownMoveUntil) return
    if (this.win.isMaximized() || this.win.isFullScreen() || this.win.isMinimized()) return
    const own = api.frame(this.ownHwnd())
    if (!own) return
    if (this.target) {
      const rect = api.exists(this.target.hwnd) ? api.frame(this.target.hwnd) : null
      if (rect && snapSide(own, rect) === this.target.side) {
        this.apply() // 还贴着，只是没对齐：摆正
        return
      }
      this.undock()
    }
    const picked = pickTarget(own, this.candidates(), (r) => this.workArea(r))
    if (!picked) return
    this.target = { hwnd: picked.target.hwnd, side: picked.side, title: picked.target.title, lastRect: null, width: null }
    this.lastForeground = api.foreground()
    this.apply()
    this.timer = setInterval(() => this.follow(), FOLLOW_MS)
    this.onState(this.state())
  }

  // 吸着的时候用户自己拉了画布的宽度：记住这个宽度，位置和高度仍然跟着目标
  private userResized(): void {
    const api = this.api
    if (!api || !this.target || this.win.isDestroyed() || Date.now() < this.ownMoveUntil) return
    const own = api.frame(this.ownHwnd())
    if (own) this.target.width = own.w
    this.apply()
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.target = null
  }

  private undock(): void {
    this.stop()
    if (!this.win.isDestroyed()) this.onState(this.state())
  }

  private ownHwnd(): Hwnd {
    return Number(this.win.getNativeWindowHandle().readBigUInt64LE(0))
  }

  // 能吸的窗口，按叠放顺序从上到下：看得见、没最小化、不是系统外壳和各种浮层，也不是我们自己进程的窗口
  private candidates(): { hwnd: Hwnd; title: string; rect: Rect }[] {
    const api = this.api!
    const out: { hwnd: Hwnd; title: string; rect: Rect }[] = []
    let guard = 0
    for (let h = api.topWindow(); h && guard < 2000; h = api.nextWindow(h), guard++) {
      if (!api.visible(h) || api.minimized(h) || api.cloaked(h)) continue
      if (api.exStyle(h) & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT)) continue
      if (api.pid(h) === process.pid) continue
      const title = api.title(h)
      if (!title || SHELL_CLASSES.has(api.className(h))) continue
      const rect = api.frame(h)
      if (!rect || rect.w < 300 || rect.h < 200) continue
      out.push({ hwnd: h, title, rect })
    }
    return out
  }

  // 目标窗口所在屏幕的工作区（不含任务栏），物理像素
  private workArea(rect: Rect): Rect {
    const dip = screen.screenToDipRect(null, { x: rect.x, y: rect.y, width: rect.w, height: rect.h })
    const area = screen.dipToScreenRect(null, screen.getDisplayMatching(dip).workArea)
    return { x: area.x, y: area.y, w: area.width, h: area.height }
  }

  // 按目标窗口现在的位置把画布摆好
  private apply(): void {
    const api = this.api!
    const t = this.target
    if (!t || this.win.isDestroyed() || this.win.isMinimized()) return
    const rect = api.frame(t.hwnd)
    if (!rect || api.minimized(t.hwnd)) return
    t.lastRect = rect
    const want = dockedRect(rect, t.side, this.workArea(rect), { width: t.width })
    if (!want) return // 目标最大化了，旁边没地方：先不动，等它让出位置
    const own = this.ownHwnd()
    const frame = api.frame(own)
    const outer = api.outer(own)
    // 系统记的窗口矩形比看得见的那一圈大一点（拖拽边），摆的时候要把这一圈加回去
    const pad =
      frame && outer
        ? { l: frame.x - outer.x, t: frame.y - outer.y, r: outer.x + outer.w - (frame.x + frame.w), b: outer.y + outer.h - (frame.y + frame.h) }
        : { l: 0, t: 0, r: 0, b: 0 }
    if (frame && sameRect(frame, want)) return
    const dip = screen.screenToDipRect(this.win, {
      x: want.x - pad.l,
      y: want.y - pad.t,
      width: want.w + pad.l + pad.r,
      height: want.h + pad.t + pad.b
    })
    this.ownMoveUntil = Date.now() + OWN_MOVE_MS
    this.win.setBounds(dip)
  }

  // 吸着的时候定时看一眼目标：挪了、缩放了就跟上；它回到前台，画布也跟着浮上来
  private follow(): void {
    const api = this.api!
    const t = this.target
    if (!t) return
    if (this.win.isDestroyed() || !api.exists(t.hwnd)) {
      this.undock()
      return
    }
    const fg = api.foreground()
    if (fg !== this.lastForeground) {
      this.lastForeground = fg
      if (fg === t.hwnd && !this.win.isMinimized() && !api.minimized(t.hwnd)) this.win.moveTop()
    }
    if (api.minimized(t.hwnd)) return
    const rect = api.frame(t.hwnd)
    if (rect && !sameRect(rect, t.lastRect)) this.apply()
  }
}
