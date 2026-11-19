// 剥掉 .excalidraw 场景里能执行脚本的字段。
//
// CVE-2026-97224：Excalidraw（<= 0.18.1，上游未修）会把 iframe 元素的
// customData.generationData.html 原样保留，并当作 srcdoc 渲染进画布里的 iframe，
// 打开一个构造好的文件就会执行其中的脚本。Flying draws 自己从不写 generationData，
// 所以凡是从外面进来的场景（画板文件、打开 / 拖入的文件、素材库），一律把这个字段拿掉。

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** 这个元素带不带会被当成 HTML 渲染的 generationData。 */
export function hasUnsafeCustomData(el: unknown): boolean {
  return isObj(el) && isObj(el.customData) && 'generationData' in el.customData
}

/** 返回去掉 customData.generationData 的元素；没有这个字段时原样返回同一个对象。 */
export function sanitizeElement<T>(el: T): T {
  if (!hasUnsafeCustomData(el)) return el
  const rec = el as unknown as Obj
  const { generationData: _dropped, ...rest } = rec.customData as Obj
  return { ...rec, customData: rest } as T
}

/** 清洗一组元素，并告诉调用方剥掉了几个。没有要剥的时 elements 就是传进来的数组。 */
export function sanitizeElements<T>(elements: readonly T[]): { elements: readonly T[]; stripped: number } {
  let stripped = 0
  const next = elements.map((el) => {
    const clean = sanitizeElement(el)
    if (clean !== el) stripped += 1
    return clean
  })
  return { elements: stripped > 0 ? next : elements, stripped }
}

/** 清洗一个场景对象（{ elements, appState, files }），其他字段不动。 */
export function sanitizeScene<S extends { elements?: readonly unknown[] }>(scene: S): { scene: S; stripped: number } {
  if (!Array.isArray(scene.elements)) return { scene, stripped: 0 }
  const { elements, stripped } = sanitizeElements(scene.elements)
  return { scene: stripped > 0 ? { ...scene, elements } : scene, stripped }
}

/**
 * 清洗素材库条目。兼容 v2（{ elements: [...] }）和 v1（直接是元素数组）两种写法。
 */
export function sanitizeLibraryItems(items: readonly unknown[]): { items: unknown[]; stripped: number } {
  let stripped = 0
  const next = items.map((item) => {
    if (Array.isArray(item)) {
      const r = sanitizeElements(item)
      stripped += r.stripped
      return r.elements
    }
    if (isObj(item) && Array.isArray(item.elements)) {
      const r = sanitizeElements(item.elements)
      stripped += r.stripped
      return r.stripped > 0 ? { ...item, elements: r.elements } : item
    }
    return item
  })
  return { items: next, stripped }
}
