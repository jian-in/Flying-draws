// 画布背景色：默认是淡黄的纸色。
//
// 老版本存的画板里，纯白 #ffffff 多半是 Excalidraw 的默认白（新建画板也写过纯白），载入时换成纸色。
// 新版本存盘时在 flyingdraws 里标上 exactBackground：存下来的就是用户当时看到的背景色，
// 载入时原样恢复，用户自己从调色板选的纯白也留得住。
export const PAPER_COLOR = '#fffbe6'

/** 纯白或没设背景色时用纸色，其余原样 */
export const paperOr = (color: unknown): string =>
  typeof color === 'string' && color && color.toLowerCase() !== '#ffffff' ? color : PAPER_COLOR

/** 画板文件的 flyingdraws 字段里有没有「背景色按原样恢复」的标记 */
export const hasExactBackground = (meta: unknown): boolean =>
  typeof meta === 'object' && meta !== null && (meta as Record<string, unknown>).exactBackground === true

/** 载入画板时用的背景色：带标记的原样恢复，老画板按 paperOr 处理 */
export function boardBackground(color: unknown, meta: unknown): string {
  return hasExactBackground(meta) && typeof color === 'string' && color ? color : paperOr(color)
}
