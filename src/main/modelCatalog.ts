/** 从服务商的模型列表端点拉取可选模型，喂给设置面板的下拉框。纯逻辑 + 一个可替换的 fetch，便于测试。 */

export type ProviderProtocol = 'openai-compatible' | 'anthropic-messages' | 'gemini'

export interface CatalogDraft {
  protocol: ProviderProtocol
  base_url: string
  credential: string
}

interface FetchResponse {
  ok: boolean
  status: number
  text(): Promise<string>
}

/** 只依赖 fetch 的这三个成员，测试里可以塞一个假响应 */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal }
) => Promise<FetchResponse>

const PROTOCOLS: readonly ProviderProtocol[] = ['openai-compatible', 'anthropic-messages', 'gemini']
const DEFAULT_TIMEOUT_MS = 10_000
/** 响应正文只用来判断是不是 JSON；不需要整份，留一点余量够报错 */
const MAX_BODY = 8 * 1024 * 1024

function fail(message: string): never {
  throw new Error(message)
}

function protocolOf(value: unknown): ProviderProtocol {
  if (!PROTOCOLS.includes(value as ProviderProtocol)) fail('接口协议无效')
  return value as ProviderProtocol
}

/** 服务地址的尾部斜杠、以及重复的端点后缀都去掉，拼出来才是干净的 URL */
function trimBase(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) fail('服务地址不能为空')
  let base = value.trim().replace(/\/+$/, '')
  if (base.length > 2048) fail('服务地址过长')
  let url: URL
  try { url = new URL(base) } catch { fail('服务地址不是有效的网址') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('服务地址必须是 http 或 https')
  if (url.username || url.password) fail('服务地址里不能带用户名或密码')
  return base
}

/** 各协议的模型列表端点：OpenAI 兼容与 Anthropic 在 {base}/models，Gemini 在 {base}/v1beta/models */
export function modelsUrl(draft: Pick<CatalogDraft, 'protocol' | 'base_url'>): string {
  const base = trimBase(draft.base_url)
  const protocol = protocolOf(draft.protocol)
  // 已经有版本段/端点后缀时不重复拼
  const strip = (suffix: string) => (base.toLowerCase().endsWith(suffix) ? base.slice(0, -suffix.length) : base)
  if (protocol === 'openai-compatible') return `${strip('/models')}/models`
  if (protocol === 'anthropic-messages') {
    const root = strip('/v1')
    return `${root}/v1/models`
  }
  return `${strip('/v1beta')}/v1beta/models`
}

function idsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined
    if (typeof id !== 'string') continue
    const trimmed = id.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/** 解析模型列表响应。解析不了直接报错，响应形状不对返回空列表。 */
export function parseModelIds(protocol: ProviderProtocol, body: string): string[] {
  if (typeof body === 'string' && !body.trim()) return []
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { fail('服务商返回的不是 JSON，检查服务地址是否指向模型接口') }
  if (!parsed || typeof parsed !== 'object') return []
  if (protocol === 'gemini') {
    const models = (parsed as { models?: unknown }).models
    if (!Array.isArray(models)) return []
    const out: string[] = []
    for (const item of models) {
      const name = item && typeof item === 'object' ? (item as { name?: unknown }).name : undefined
      if (typeof name !== 'string') continue
      const id = name.trim().replace(/^models\//, '').trim()
      if (id && !out.includes(id)) out.push(id)
    }
    return out
  }
  return idsFrom((parsed as { data?: unknown }).data)
}

/** `env:变量名` 取进程环境里的密钥；变量不存在时返回空串，由调用方决定怎么处理 */
export function resolveCredential(credential: string, env: Record<string, string | undefined> = process.env): string {
  if (typeof credential !== 'string') return ''
  const text = credential.trim()
  if (!text) return ''
  if (!/^env:/i.test(text)) return text
  const name = text.slice(4).trim()
  return name ? env[name] ?? '' : ''
}

/** 拉取模型 ID 列表。失败信息只描述状态和原因，不回显密钥和响应正文。 */
export async function listProviderModels(
  draft: CatalogDraft,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
  options: { timeoutMs?: number; env?: Record<string, string | undefined> } = {}
): Promise<string[]> {
  const url = modelsUrl(draft)
  const credential = resolveCredential(draft.credential, options.env)
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (credential) {
    if (draft.protocol === 'anthropic-messages') {
      headers['x-api-key'] = credential
      headers['anthropic-version'] = '2023-06-01'
    } else if (draft.protocol === 'gemini') {
      headers['x-goog-api-key'] = credential
    } else {
      headers['Authorization'] = `Bearer ${credential}`
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal })
    const body = await response.text()
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403
        ? '，检查 API Key 是否有效'
        : response.status === 404 ? '，检查服务地址是否指向模型接口' : ''
      fail(`拉取模型列表失败：HTTP ${response.status}${hint}`)
    }
    if (body.length > MAX_BODY) fail('模型列表响应过大')
    return parseModelIds(protocolOf(draft.protocol), body)
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))) {
      fail(`拉取模型列表超时（${Math.round(timeoutMs / 1000)} 秒），检查网络或服务地址`)
    }
    if (error instanceof Error && error.message.startsWith('拉取模型列表') === false && /fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network/i.test(error.message)) {
      fail('连不上服务地址，检查网络、地址和代理设置')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
