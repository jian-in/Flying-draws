// 窗口吸附：把画布窗口拖到别的窗口（比如 agent 的客户端）旁边松手，它就贴上去——
// 和那个窗口垂直对齐（裁剪在工作区内），保持画布当前宽度（或用户拉过的宽度），之后跟着那个窗口移动、缩放、回到前台。
// 一拖开就立即解除吸附，不粘手。几何判断在 dockGeometry.ts，这里只管和系统窗口打交道。
// 目前只在 Windows 上生效（靠 user32 / dwmapi 读写窗口位置与监听事件），其他系统上什么都不做。
import { screen, type BrowserWindow, type Rectangle } from 'electron'
import koffi from 'koffi'
import { dockedRect, nearRect, pickTarget, sameRect, snapSide, type DockSide, type Rect } from './dockGeometry'

export interface DockState {
  docked: boolean
  side: DockSide | null
  title: string | null // 贴着的那个窗口的标题
}

type Hwnd = number
type HookHandle = number | bigint
type RawRect = { left: number; top: number; right: number; bottom: number }
type Pad = { l: number; t: number; r: number; b: number }

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
  workArea: (r: Rect) => Rect | null // 物理像素工作区（不含任务栏）
  setPos: (h: Hwnd, x: number, y: number, w: number, hgt: number) => boolean
  winEventProcPtr: ReturnType<typeof koffi.pointer>
  setWinEventHook: (
    eventMin: number,
    eventMax: number,
    hmod: number,
    cb: bigint,
    idProcess: number,
    idThread: number,
    flags: number
  ) => HookHandle
  unhookWinEvent: (hHook: HookHandle) => boolean
}

let cachedWin32: Win32 | null | undefined

function loadWin32(): Win32 | null {
  if (cachedWin32 !== undefined) return cachedWin32
  if (process.platform !== 'win32') {
    cachedWin32 = null
    return null
  }
  try {
    const user32 = koffi.load('user32.dll')
    const dwmapi = koffi.load('dwmapi.dll')
    const RECT = koffi.struct('FD_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
    const MONITORINFO = koffi.struct('FD_MONITORINFO', {
      cbSize: 'uint32_t',
      rcMonitor: RECT,
      rcWork: RECT,
      dwFlags: 'uint32_t'
    })
    const WinEventProc = koffi.proto(
      'void __stdcall FD_WinEventProc(uintptr_t hWinEventHook, uint32_t event, uintptr_t hwnd, int32_t idObject, int32_t idChild, uint32_t idEventThread, uint32_t dwmsEventTime)'
    )
    const winEventProcPtr = koffi.pointer(WinEventProc)
    const monitorInfoSize = koffi.sizeof(MONITORINFO)

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
    const SetWindowPos = user32.func(
      'int __stdcall SetWindowPos(uintptr_t hWnd, uintptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)'
    )
    const MonitorFromRect = user32.func('uintptr_t __stdcall MonitorFromRect(FD_RECT *lprc, uint32_t dwFlags)')
    const GetMonitorInfoW = user32.func('int __stdcall GetMonitorInfoW(uintptr_t hMonitor, _Inout_ FD_MONITORINFO *lpmi)')
    const SetWinEventHook = user32.func(
      'uintptr_t __stdcall SetWinEventHook(uint32_t eventMin, uint32_t eventMax, uintptr_t hmodWinEventProc, uintptr_t pfnWinEventProc, uint32_t idProcess, uint32_t idThread, uint32_t dwFlags)'
    )
    const UnhookWinEvent = user32.func('int __stdcall UnhookWinEvent(uintptr_t hWinEventHook)')
    const DwmGetRect = dwmapi.func('long __stdcall DwmGetWindowAttribute(uintptr_t h, uint32_t attr, _Out_ FD_RECT *out, uint32_t size)')
    const DwmGetInt = dwmapi.func('long __stdcall DwmGetWindowAttribute(uintptr_t h, uint32_t attr, _Out_ int *out, uint32_t size)')

    const GW_HWNDNEXT = 2
    const GWL_EXSTYLE = -20
    const DWMWA_EXTENDED_FRAME_BOUNDS = 9
    const DWMWA_CLOAKED = 14
    const SWP_NOZORDER = 0x0004
    const SWP_NOACTIVATE = 0x0010
    const MONITOR_DEFAULTTONEAREST = 0x0002

    const text = (fn: (h: Hwnd, buf: Uint16Array, max: number) => number, h: Hwnd): string => {
      const buf = new Uint16Array(256)
      const n = fn(h, buf, 256)
      return n > 0 ? String.fromCharCode(...buf.subarray(0, n)) : ''
    }
    const toRect = (r: RawRect): Rect | null =>
      r.right > r.left && r.bottom > r.top ? { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top } : null

    cachedWin32 = {
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
      },
      workArea: (r) => {
        const hMon = MonitorFromRect({ left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h }, MONITOR_DEFAULTTONEAREST)
        if (!hMon) return null
        const mi = {
          cbSize: monitorInfoSize,
          rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 },
          rcWork: { left: 0, top: 0, right: 0, bottom: 0 },
          dwFlags: 0
        }
        return GetMonitorInfoW(hMon, mi) ? toRect(mi.rcWork) : null
      },
      setPos: (h, x, y, w, hgt) => Boolean(SetWindowPos(h, 0, x, y, w, hgt, SWP_NOZORDER | SWP_NOACTIVATE)),
      winEventProcPtr,
      setWinEventHook: (eventMin, eventMax, hmod, cb, idProcess, idThread, flags) =>
        SetWinEventHook(eventMin, eventMax, hmod, cb, idProcess, idThread, flags),
      unhookWinEvent: (hHook) => Boolean(UnhookWinEvent(hHook))
    }
    return cachedWin32
  } catch (err) {
    console.error('[flyingdraws] window docking is unavailable:', err)
    cachedWin32 = null
    return null
  }
}

const WS_EX_TRANSPARENT = 0x20
const WS_EX_TOOLWINDOW = 0x80
const WS_EX_NOACTIVATE = 0x08000000
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'])

const EVENT_SYSTEM_FOREGROUND = 0x0003
const EVENT_OBJECT_LOCATIONCHANGE = 0x800b
const WINEVENT_OUTOFCONTEXT = 0x0000
const OBJID_WINDOW = 0
const CHILDID_SELF = 0

const FALLBACK_CHECK_MS = 500
const ADAPTIVE_FAST_MS = 16
const ADAPTIVE_IDLE_MS = 120
const APPLY_ECHO_TOL_PX = 2
const SEAM_DETACH_TOL_PX = 4
const DETACH_COOLDOWN_MS = 1500
const RESIZE_HOLD_MS = 250
const RESIZE_SETTLE_MS = 260

const calcPad = (frame: Rect | null, outer: Rect | null): Pad =>
  frame && outer
    ? {
        l: frame.x - outer.x,
        t: frame.y - outer.y,
        r: outer.x + outer.w - (frame.x + frame.w),
        b: outer.y + outer.h - (frame.y + frame.h)
      }
    : { l: 0, t: 0, r: 0, b: 0 }

const samePad = (a: Pad, b: Pad): boolean => a.l === b.l && a.t === b.t && a.r === b.r && a.b === b.b

const seamGap = (own: Rect, target: Rect, side: DockSide): number =>
  side === 'right' ? Math.abs(own.x - (target.x + target.w)) : Math.abs(own.x + own.w - target.x)

export class WindowDock {
  private api = loadWin32()
  private win: BrowserWindow
  private onState: (s: DockState) => void
  private target: { hwnd: Hwnd; side: DockSide; title: string; lastRect: Rect | null; width: number | null } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private resizeSettleTimer: ReturnType<typeof setTimeout> | null = null
  private hooks: HookHandle[] = []
  private hookCb: bigint | null = null
  private hookFn: ((hHook: HookHandle, event: number, hwnd: HookHandle, idObject: number, idChild: number) => void) | null = null
  private hooksActive = false
  private inWinEvent = false
  private inFollow = false
  private applying = false
  private lastAppliedFrame: Rect | null = null
  private resizingUntil = 0
  private lastTargetMoveAt = 0
  private suppressed: { hwnd: Hwnd; side: DockSide; until: number; dist: number } | null = null
  private lastForeground: Hwnd = 0

  constructor(win: BrowserWindow, onState: (s: DockState) => void) {
    this.win = win
    this.onState = onState
    if (!this.api) return
    win.on('will-move', (_event, newBounds) => this.onWillMove(newBounds))
    win.on('moved', () => this.userMoved())
    win.on('will-resize', (_event, newBounds, details) => this.onWillResize(newBounds, details.edge))
    win.on('resized', () => this.onResized())
    win.on('closed', () => this.stop())
  }

  state(): DockState {
    return { docked: Boolean(this.target), side: this.target?.side ?? null, title: this.target?.title ?? null }
  }

  // 用户点了「解除吸附」
  release(): void {
    if (this.target) this.detachByUser()
  }

  private onWillMove(newBounds: Rectangle): void {
    if (!this.api || !this.target || this.applying || this.win.isDestroyed()) return
    const cur = this.win.getBounds()
    if (Math.abs(newBounds.x - cur.x) <= 2 && Math.abs(newBounds.y - cur.y) <= 2) return
    this.detachByUser()
  }

  private onWillResize(newBounds: Rectangle, edge: string): void {
    if (!this.api || !this.target || this.applying || this.win.isDestroyed()) return
    const t = this.target
    const isSeamEdge = (t.side === 'right' && edge.includes('left')) || (t.side === 'left' && edge.includes('right'))
    if (isSeamEdge) {
      const cur = this.win.getBounds()
      const movedSeam =
        t.side === 'right'
          ? Math.abs(newBounds.x - cur.x) > 2
          : Math.abs(newBounds.x + newBounds.width - (cur.x + cur.width)) > 2
      if (movedSeam) {
        this.detachByUser()
        return
      }
    }
    this.resizingUntil = Date.now() + RESIZE_HOLD_MS
    this.scheduleResizeSettle()
  }

  // 用户拖完画布松手：贴着别的窗口就吸上去，从吸着的窗口旁边拖开就立刻解除
  userMoved(force = false): void {
    const api = this.api
    if (!api || this.win.isDestroyed()) return
    if (!force && this.applying) return
    if (this.win.isMaximized() || this.win.isFullScreen() || this.win.isMinimized()) {
      if (this.target) this.undock()
      return
    }
    const own = api.frame(this.ownHwnd())
    if (!own) return
    if (this.target) {
      if (!force && nearRect(own, this.lastAppliedFrame, APPLY_ECHO_TOL_PX)) return
      this.detachByUser(own)
    }
    this.clearSuppressedIfOutside(own)
    const picked = pickTarget(own, this.candidates(), (r) => this.workArea(r), {
      accept: (c, side) => this.canSnapTo(c.hwnd, side, own, c.rect)
    })
    if (!picked) return
    this.target = { hwnd: picked.target.hwnd, side: picked.side, title: picked.target.title, lastRect: null, width: null }
    this.suppressed = null
    this.lastForeground = api.foreground()
    this.lastTargetMoveAt = Date.now()
    this.apply()
    this.hooksActive = this.startHooks()
    this.scheduleFollowCheck()
    this.onState(this.state())
  }

  // 吸着的时候用户自己拉了画布的边：拉外侧边就平滑记住宽度（拖拽过程中不硬拉回 y/h），拉贴合边就解除吸附
  private onResized(): void {
    const api = this.api
    if (!api || !this.target || this.applying || this.win.isDestroyed()) return
    if (this.win.isMaximized() || this.win.isFullScreen()) {
      this.undock()
      return
    }
    const own = api.frame(this.ownHwnd())
    if (!own) return
    if (nearRect(own, this.lastAppliedFrame, APPLY_ECHO_TOL_PX)) return
    const t = this.target
    const targetRect = api.exists(t.hwnd) ? api.frame(t.hwnd) : null
    if (targetRect && seamGap(own, targetRect, t.side) > SEAM_DETACH_TOL_PX) {
      this.recordSuppressed(t.hwnd, t.side, own, targetRect)
      this.undock()
      return
    }
    t.width = own.w
    this.lastAppliedFrame = own
    this.resizingUntil = Date.now() + RESIZE_HOLD_MS
    this.scheduleResizeSettle()
  }

  private scheduleResizeSettle(): void {
    if (this.resizeSettleTimer) clearTimeout(this.resizeSettleTimer)
    this.resizeSettleTimer = setTimeout(() => {
      this.resizeSettleTimer = null
      if (!this.target || this.applying || this.win.isDestroyed()) return
      const remaining = this.resizingUntil - Date.now()
      if (remaining > 0) {
        this.scheduleResizeSettle()
        return
      }
      this.apply()
    }, RESIZE_SETTLE_MS)
  }

  private recordSuppressed(hwnd: Hwnd, side: DockSide, own: Rect | null, targetRect: Rect | null): void {
    const dist = own && targetRect ? seamGap(own, targetRect, side) : 0
    this.suppressed = { hwnd, side, until: Date.now() + DETACH_COOLDOWN_MS, dist }
  }

  private detachByUser(ownOverride?: Rect): void {
    const t = this.target
    if (!t) return
    const api = this.api
    const own = ownOverride ?? api?.frame(this.ownHwnd()) ?? this.lastAppliedFrame
    const targetRect = api && api.exists(t.hwnd) ? api.frame(t.hwnd) : null
    this.recordSuppressed(t.hwnd, t.side, own, targetRect)
    this.undock()
  }

  private clearSuppressedIfOutside(own: Rect): void {
    const s = this.suppressed
    const api = this.api
    if (!s || !api) return
    const sr = api.exists(s.hwnd) ? api.frame(s.hwnd) : null
    if (!sr || snapSide(own, sr) !== s.side) this.suppressed = null
  }

  private canSnapTo(hwnd: Hwnd, side: DockSide, own: Rect, targetRect: Rect): boolean {
    const s = this.suppressed
    if (!s || s.hwnd !== hwnd || s.side !== side) return true
    const dist = seamGap(own, targetRect, side)
    if (Date.now() < s.until || dist >= s.dist) {
      s.dist = Math.max(s.dist, dist)
      return false
    }
    this.suppressed = null
    return true
  }

  private startHooks(): boolean {
    const api = this.api
    if (!api) return false
    try {
      const fn = (_hHook: HookHandle, event: number, hwnd: HookHandle, idObject: number, idChild: number): void => {
        const t = this.target
        if (!t || this.win.isDestroyed()) return
        const h = Number(hwnd)
        if (event === EVENT_OBJECT_LOCATIONCHANGE) {
          if (idObject !== OBJID_WINDOW || idChild !== CHILDID_SELF || h !== t.hwnd) return
        } else if (event !== EVENT_SYSTEM_FOREGROUND) {
          return
        }
        this.inWinEvent = true
        try {
          this.follow()
        } finally {
          this.inWinEvent = false
        }
      }
      const cb = koffi.register(fn, api.winEventProcPtr)
      const hFg = api.setWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, 0, cb, 0, 0, WINEVENT_OUTOFCONTEXT)
      const hLoc = api.setWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, 0, cb, 0, 0, WINEVENT_OUTOFCONTEXT)
      if (!hFg || !hLoc) {
        if (hFg) {
          try {
            api.unhookWinEvent(hFg)
          } catch {}
        }
        if (hLoc) {
          try {
            api.unhookWinEvent(hLoc)
          } catch {}
        }
        try {
          koffi.unregister(cb)
        } catch {}
        return false
      }
      this.hookFn = fn
      this.hookCb = cb
      this.hooks = [hFg, hLoc]
      return true
    } catch (err) {
      console.warn('[flyingdraws] SetWinEventHook unavailable, falling back to polling:', err)
      return false
    }
  }

  private scheduleFollowCheck(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.target) return
    const delay = this.hooksActive
      ? FALLBACK_CHECK_MS
      : Date.now() - this.lastTargetMoveAt < 350
        ? ADAPTIVE_FAST_MS
        : ADAPTIVE_IDLE_MS
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.target) return
      this.follow()
      if (this.target) this.scheduleFollowCheck()
    }, delay)
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.resizeSettleTimer) clearTimeout(this.resizeSettleTimer)
    this.resizeSettleTimer = null

    const api = this.api
    for (const h of this.hooks) {
      try {
        api?.unhookWinEvent(h)
      } catch {}
    }
    this.hooks = []
    this.hooksActive = false

    const cb = this.hookCb
    this.hookCb = null
    this.hookFn = null
    if (cb !== null) {
      const release = (): void => {
        try {
          koffi.unregister(cb)
        } catch {}
      }
      if (this.inWinEvent) setImmediate(release)
      else release()
    }

    this.target = null
    this.lastAppliedFrame = null
    this.resizingUntil = 0
  }

  private undock(): void {
    this.stop()
    if (!this.win.isDestroyed()) this.onState(this.state())
  }

  private ownHwnd(): Hwnd {
    const buf = this.win.getNativeWindowHandle()
    return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0)
  }

  private isAboveTarget(ownHwnd: Hwnd, targetHwnd: Hwnd): boolean {
    const api = this.api!
    let guard = 0
    for (let h = api.topWindow(); h && guard < 200; h = api.nextWindow(h), guard++) {
      if (h === ownHwnd) return true
      if (h === targetHwnd) return false
    }
    return false
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
    const physical = this.api?.workArea(rect)
    if (physical) return physical
    const dip = screen.screenToDipRect(this.win, { x: rect.x, y: rect.y, width: rect.w, height: rect.h })
    const area = screen.dipToScreenRect(this.win, screen.getDisplayMatching(dip).workArea)
    return { x: area.x, y: area.y, w: area.width, h: area.height }
  }

  // 按目标窗口现在的位置用 SetWindowPos 在物理像素上把画布摆好，消除 DPI 换算误差
  private apply(): void {
    const api = this.api!
    const t = this.target
    if (!t || this.win.isDestroyed() || this.win.isMinimized()) return
    const rect = api.frame(t.hwnd)
    if (!rect || api.minimized(t.hwnd)) return
    t.lastRect = rect
    const own = this.ownHwnd()
    const frame = api.frame(own)
    const want = dockedRect(rect, t.side, this.workArea(rect), { width: t.width, ownWidth: frame?.w })
    if (!want) return // 目标最大化了或不在可见工作区内：先不动，等它让出位置
    if (frame && sameRect(frame, want)) {
      this.lastAppliedFrame = frame
      return
    }
    const outer = api.outer(own)
    let pad = calcPad(frame, outer)
    this.applying = true
    this.lastAppliedFrame = want
    try {
      api.setPos(own, want.x - pad.l, want.y - pad.t, want.w + pad.l + pad.r, want.h + pad.t + pad.b)
      // 跨 DPI 显示器移动后系统隐形边框宽度（pad）可能变化，重读一次并按新 pad 微调到像素对齐
      const frame2 = api.frame(own)
      const outer2 = api.outer(own)
      if (frame2 && outer2 && !sameRect(frame2, want)) {
        const pad2 = calcPad(frame2, outer2)
        if (!samePad(pad, pad2)) {
          pad = pad2
          api.setPos(own, want.x - pad.l, want.y - pad.t, want.w + pad.l + pad.r, want.h + pad.t + pad.b)
        }
      }
      this.lastAppliedFrame = api.frame(own) ?? want
    } finally {
      this.applying = false
    }
  }

  // 吸着的时候跟进目标变化：挪了、缩放了就跟上；它回到前台且画布在它后面时，画布也非侵入式浮上来
  private follow(): void {
    if (this.inFollow) return
    const api = this.api
    const t = this.target
    if (!api || !t) return
    this.inFollow = true
    try {
      if (this.win.isDestroyed() || !api.exists(t.hwnd)) {
        this.undock()
        return
      }
      const fg = api.foreground()
      if (fg !== this.lastForeground) {
        this.lastForeground = fg
        if (
          fg === t.hwnd &&
          !this.win.isMinimized() &&
          this.win.isVisible() &&
          !api.minimized(t.hwnd) &&
          !this.isAboveTarget(this.ownHwnd(), t.hwnd)
        ) {
          this.win.moveTop()
        }
      }
      if (api.minimized(t.hwnd)) return
      if (Date.now() < this.resizingUntil) return
      const rect = api.frame(t.hwnd)
      if (rect && !sameRect(rect, t.lastRect)) {
        this.lastTargetMoveAt = Date.now()
        this.apply()
      }
    } finally {
      this.inFollow = false
    }
  }
}
