import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelsUrl } from '../src/main/modelCatalog.ts'
import {
  BASE_URL_PLACEHOLDER,
  DEFAULT_PRESET,
  PROVIDER_PRESETS,
  type PresetId
} from '../src/shared/providerPresets.ts'

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const EXPECTED_PRESETS: readonly PresetId[] = [
  'deepseek-flash',
  'opencode-zen',
  'opencode-zen-claude',
  'opencode-go',
  'openrouter',
  'openai',
  'anthropic',
  'gemini',
  'zhipu',
  'zhipu-coding',
  'moonshot',
  'dashscope',
  'ark',
  'ark-coding',
  'siliconflow',
  'minimax',
  'mimo',
  'ollama',
  'custom'
]

test('默认预设保持 deepseek-flash 及其 E2E 契约字段', () => {
  assert.equal(DEFAULT_PRESET, 'deepseek-flash')
  const preset = PROVIDER_PRESETS[DEFAULT_PRESET]
  assert.equal(preset.label, 'DeepSeek · deepseek-flash（已实测，支持看图）')
  assert.deepEqual(preset.draft, {
    protocol: 'openai-compatible',
    name: 'deepseek',
    base_url: 'https://api.deepseek.com/v1',
    credential: '',
    model: 'deepseek-flash',
    context_window: 1000000,
    max_tokens: 25400,
    vision: true
  })
})

test('自定义预设重置为空白表单并关闭默认看图开关', () => {
  const custom = PROVIDER_PRESETS.custom
  assert.equal(custom.label, '自定义')
  assert.deepEqual(custom.draft, {
    protocol: 'openai-compatible',
    name: 'my-model',
    base_url: '',
    credential: '',
    model: '',
    context_window: 128000,
    max_tokens: 8192,
    vision: false
  })
})

test('包含全部约定主流服务商预设且配置名称与 token 上限合法', () => {
  const ids = Object.keys(PROVIDER_PRESETS) as PresetId[]
  assert.deepEqual(ids, EXPECTED_PRESETS)

  const seenNames = new Set<string>()
  for (const id of ids) {
    const preset = PROVIDER_PRESETS[id]
    assert.ok(preset.label.trim().length > 0, `${id} 缺少 label`)
    assert.match(preset.draft.name, NAME_PATTERN, `${id} 的 name 不符合配置名称规则`)
    assert.equal(seenNames.has(preset.draft.name), false, `预设配置名称重复：${preset.draft.name}`)
    seenNames.add(preset.draft.name)

    assert.ok(
      Number.isInteger(preset.draft.context_window) &&
        preset.draft.context_window >= 4096 &&
        preset.draft.context_window <= 2_000_000,
      `${id} 的 context_window 超出设置范围`
    )
    assert.ok(
      Number.isInteger(preset.draft.max_tokens) &&
        preset.draft.max_tokens >= 1 &&
        preset.draft.max_tokens <= preset.draft.context_window,
      `${id} 的 max_tokens 应满足 1 <= max_tokens <= context_window`
    )
    assert.equal(typeof preset.draft.vision, 'boolean')
    if (id === 'ollama') {
      assert.equal(preset.draft.credential, 'ollama')
    } else {
      assert.equal(preset.draft.credential, '')
    }
  }
})

test('所有非自定义预设的 base_url 都能通过 modelsUrl 生成合法模型列表端点', () => {
  for (const id of Object.keys(PROVIDER_PRESETS) as PresetId[]) {
    if (id === 'custom') continue
    const { protocol, base_url } = PROVIDER_PRESETS[id].draft
    const url = modelsUrl({ protocol, base_url })
    const parsed = new URL(url)
    assert.ok(parsed.protocol === 'http:' || parsed.protocol === 'https:', `${id} URL 协议无效：${url}`)
    assert.equal(parsed.pathname.includes('//'), false, `${id} URL 存在双斜杠：${url}`)
    assert.ok(url.endsWith('/models'), `${id} modelsUrl 应以 /models 结尾：${url}`)
  }
})

test('BASE_URL_PLACEHOLDER 与 Fuxi 协议路径约定一致', () => {
  assert.deepEqual(BASE_URL_PLACEHOLDER, {
    'openai-compatible': 'https://api.deepseek.com/v1',
    'anthropic-messages': 'https://api.anthropic.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta'
  })
  for (const [protocol, base_url] of Object.entries(BASE_URL_PLACEHOLDER) as Array<
    [keyof typeof BASE_URL_PLACEHOLDER, string]
  >) {
    assert.ok(modelsUrl({ protocol, base_url }).endsWith('/models'))
  }
})
