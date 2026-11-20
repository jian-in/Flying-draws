import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listProviderModels, modelsUrl, parseModelIds, resolveCredential } from '../src/main/modelCatalog.ts'

type Call = { url: string; headers: Record<string, string> }
/** 记录收到的请求，并按给定状态码/正文回应 */
function fakeFetch(body: string, init: { status?: number } = {}) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, options: { headers: Record<string, string> }) => {
    calls.push({ url, headers: options.headers })
    return { ok: (init.status ?? 200) < 400, status: init.status ?? 200, text: async () => body }
  }
  return { calls, fetchImpl }
}

test('OpenAI 兼容：走 {base_url}/models，取 data[].id', () => {
  assert.equal(modelsUrl({ protocol: 'openai-compatible', base_url: 'https://api.deepseek.com/v1' }), 'https://api.deepseek.com/v1/models')
  // 尾斜杠不产生双斜杠
  assert.equal(modelsUrl({ protocol: 'openai-compatible', base_url: 'https://api.deepseek.com/v1/' }), 'https://api.deepseek.com/v1/models')
  assert.deepEqual(parseModelIds('openai-compatible', JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-chat' }] })), ['deepseek-flash', 'deepseek-chat'])
})

test('Anthropic：走 /v1/models，取 data[].id', () => {
  assert.equal(modelsUrl({ protocol: 'anthropic-messages', base_url: 'https://api.anthropic.com' }), 'https://api.anthropic.com/v1/models')
  assert.equal(modelsUrl({ protocol: 'anthropic-messages', base_url: 'https://api.anthropic.com/v1' }), 'https://api.anthropic.com/v1/models')
  assert.deepEqual(parseModelIds('anthropic-messages', JSON.stringify({ data: [{ id: 'claude-sonnet-4-5' }] })), ['claude-sonnet-4-5'])
})

test('Gemini：走 /v1beta/models，剥掉 models/ 前缀', () => {
  assert.equal(modelsUrl({ protocol: 'gemini', base_url: 'https://generativelanguage.googleapis.com' }), 'https://generativelanguage.googleapis.com/v1beta/models')
  assert.deepEqual(parseModelIds('gemini', JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash' }, { name: 'gemini-2.5-pro' }] })), ['gemini-2.5-flash', 'gemini-2.5-pro'])
})

test('列表去重并保留顺序，忽略空项', () => {
  assert.deepEqual(parseModelIds('openai-compatible', JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, { id: '' }, {}] })), ['b', 'a'])
})

test('凭据可以用 env:变量名，变量缺失时说清是哪个变量', () => {
  assert.equal(resolveCredential('sk-plain'), 'sk-plain')
  assert.equal(resolveCredential('env:MY_KEY', { MY_KEY: 'sk-from-env' }), 'sk-from-env')
  assert.equal(resolveCredential('  env:MY_KEY  ', { MY_KEY: 'sk-from-env' }), 'sk-from-env')
  assert.equal(resolveCredential('env:MISSING', {}), '')
})

test('按协议带认证头，实际请求里不出现环境变量字面量', async () => {
  const openai = fakeFetch(JSON.stringify({ data: [{ id: 'm1' }] }))
  await listProviderModels({ protocol: 'openai-compatible', base_url: 'https://api.deepseek.com/v1', credential: 'env:MY_KEY' }, openai.fetchImpl, { env: { MY_KEY: 'sk-real' } })
  assert.equal(openai.calls.length, 1)
  assert.equal(openai.calls[0].url, 'https://api.deepseek.com/v1/models')
  assert.equal(openai.calls[0].headers['Authorization'], 'Bearer sk-real')

  const anthropic = fakeFetch(JSON.stringify({ data: [{ id: 'claude' }] }))
  await listProviderModels({ protocol: 'anthropic-messages', base_url: 'https://api.anthropic.com', credential: 'sk-ant' }, anthropic.fetchImpl)
  assert.equal(anthropic.calls[0].headers['x-api-key'], 'sk-ant')
  assert.equal(anthropic.calls[0].headers['anthropic-version'], '2023-06-01')
  assert.equal(anthropic.calls[0].headers['Authorization'], undefined)

  const gemini = fakeFetch(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash' }] }))
  await listProviderModels({ protocol: 'gemini', base_url: 'https://generativelanguage.googleapis.com', credential: 'gk' }, gemini.fetchImpl)
  assert.equal(gemini.calls[0].headers['x-goog-api-key'], 'gk')
})

test('HTTP 失败给可读消息，且不把密钥写进错误', async () => {
  const failing = fakeFetch('{"error":"invalid key sk-secret"}', { status: 401 })
  await assert.rejects(
    listProviderModels({ protocol: 'openai-compatible', base_url: 'https://api.deepseek.com/v1', credential: 'sk-secret' }, failing.fetchImpl),
    (error: unknown) => {
      const text = String((error as Error).message)
      assert.match(text, /401/)
      assert.doesNotMatch(text, /sk-secret/)
      return true
    }
  )
})

test('非 JSON 与服务地址非法都明确报错', async () => {
  const notJson = fakeFetch('<html>gateway</html>')
  await assert.rejects(listProviderModels({ protocol: 'openai-compatible', base_url: 'https://api.deepseek.com/v1', credential: 'k' }, notJson.fetchImpl), /不是 JSON/)
  assert.throws(() => modelsUrl({ protocol: 'openai-compatible', base_url: 'file:///tmp/x' }), /http/)
  assert.throws(() => modelsUrl({ protocol: 'openai-compatible', base_url: '不是地址' }), /服务地址/)
})

test('超时与非数组响应都落到可读错误', async () => {
  const hanging = async () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  }
  await assert.rejects(
    listProviderModels({ protocol: 'openai-compatible', base_url: 'https://api.deepseek.com/v1', credential: 'k' }, hanging, { timeoutMs: 20 }),
    /超时/
  )
  assert.deepEqual(parseModelIds('openai-compatible', JSON.stringify({ data: 'nope' })), [])
  assert.deepEqual(parseModelIds('openai-compatible', '{}'), [])
})

test('没有可用模型时返回空列表，不抛', async () => {
  const empty = fakeFetch(JSON.stringify({ data: [] }))
  assert.deepEqual(await listProviderModels({ protocol: 'openai-compatible', base_url: 'https://api.deepseek.com/v1', credential: 'k' }, empty.fetchImpl), [])
})
