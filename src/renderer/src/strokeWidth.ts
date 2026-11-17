// 描边宽度滑杆的刻度换算（纯函数）。
// 滑杆是 0–100，Excalidraw 里的描边宽度是像素：一格 0.2 像素，原来的三档「细 / 粗 / 特粗」是 1 / 2 / 4 像素，
// 对应滑杆上的 5 / 10 / 20，拉满 100 是 20 像素。0 不能真的画成 0 像素（线就看不见了），按 0.1 像素的发丝线算。

export const STROKE_SLIDER_MAX = 100
export const STROKE_PX_PER_STEP = 0.2
export const STROKE_HAIRLINE_PX = 0.1

export function sliderToStrokeWidth(value: number): number {
  const v = Number.isFinite(value) ? Math.min(STROKE_SLIDER_MAX, Math.max(0, Math.round(value))) : 0
  return v === 0 ? STROKE_HAIRLINE_PX : Math.round(v * STROKE_PX_PER_STEP * 100) / 100
}

export function strokeWidthToSlider(px: number): number {
  if (!Number.isFinite(px) || px < (STROKE_HAIRLINE_PX + STROKE_PX_PER_STEP) / 2) return 0
  return Math.min(STROKE_SLIDER_MAX, Math.max(1, Math.round(px / STROKE_PX_PER_STEP)))
}
