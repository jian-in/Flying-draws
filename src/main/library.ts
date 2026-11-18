// 本地素材库持久化与远端素材包体积/格式校验。
import { existsSync } from 'node:fs'
import { readFile, rename } from 'node:fs/promises'
import { atomicWriteJson } from './atomicWrite.ts'
import { MAX_LIBRARY_BYTES } from '../shared/library.ts'

export interface PersistedLibraryFile {
  type: 'excalidrawlib'
  version: 2
  source: string
  libraryItems: unknown[]
}

export function parseAndValidateLibraryJson(
  rawText: string,
  maxBytes = MAX_LIBRARY_BYTES
): { json: string; items: unknown[]; itemCount: number } {
  const byteLength = Buffer.byteLength(rawText, 'utf8')
  if (byteLength > maxBytes) {
    throw new Error(`素材库文件体积超出上限（>${Math.round(maxBytes / (1024 * 1024))} MiB）`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    throw new Error('素材库文件不是合法的 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('素材库文件内容格式无效')
  }
  const record = parsed as { type?: unknown; libraryItems?: unknown; library?: unknown }
  if (record.type !== undefined && record.type !== 'excalidrawlib') {
    throw new Error('不是有效的 Excalidraw 素材库文件')
  }
  const items = Array.isArray(record.libraryItems)
    ? record.libraryItems
    : Array.isArray(record.library)
      ? record.library
      : null
  if (!items) {
    throw new Error('素材库文件缺少 libraryItems 列表')
  }
  return { json: rawText, items, itemCount: items.length }
}

export class LibraryStore {
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async load(): Promise<{ libraryItems: unknown[] } | null> {
    if (!existsSync(this.filePath)) return null
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch {
      return null
    }
    try {
      const { items } = parseAndValidateLibraryJson(raw)
      return { libraryItems: items }
    } catch {
      const backupPath = `${this.filePath}.corrupt-${Date.now()}`
      await rename(this.filePath, backupPath).catch(() => undefined)
      return null
    }
  }

  async save(data: { libraryItems: readonly unknown[] }): Promise<void> {
    const payload: PersistedLibraryFile = {
      type: 'excalidrawlib',
      version: 2,
      source: 'flying-draws',
      libraryItems: Array.isArray(data?.libraryItems) ? [...data.libraryItems] : []
    }
    await atomicWriteJson(this.filePath, payload)
  }
}
