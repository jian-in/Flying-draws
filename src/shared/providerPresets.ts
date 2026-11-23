import type { ProviderDraft } from './agent'

/** 模型设置面板的内置服务商预设（主进程与渲染层共用定义） */
export interface ProviderPreset {
  label: string
  draft: ProviderDraft
  hint?: string
  credentialPlaceholder?: string
}

// 预设表：已覆盖的主流服务商只需填密钥（Ollama 本机免密默认填 ollama）；「自定义」由用户自己确认看图能力
const RAW_PROVIDER_PRESETS = {
  'deepseek-flash': {
    label: 'DeepSeek · deepseek-flash（已实测，支持看图）',
    draft: {
      protocol: 'openai-compatible',
      name: 'deepseek',
      base_url: 'https://api.deepseek.com/v1',
      credential: '',
      model: 'deepseek-flash',
      context_window: 1000000,
      max_tokens: 25400,
      vision: true
    },
    credentialPlaceholder: '密钥，或 env:DEEPSEEK_API_KEY',
    hint: '默认推荐，可点下方「拉取模型列表」切换 deepseek-chat / deepseek-v4-pro 等'
  },
  'opencode-zen': {
    label: 'OpenCode Zen（OpenAI 兼容 · GPT/GLM/Kimi/MiniMax 等）',
    draft: {
      protocol: 'openai-compatible',
      name: 'opencode-zen',
      base_url: 'https://opencode.ai/zen/v1',
      credential: '',
      model: '',
      context_window: 200000,
      max_tokens: 16384,
      vision: true
    },
    credentialPlaceholder: '密钥（或 env:OPENCODE_API_KEY；免费模型可试 public）',
    hint: '先填 API Key 后点「拉取模型列表」选择模型（如免费或付费模型）'
  },
  'opencode-zen-claude': {
    label: 'OpenCode Zen · Claude（Anthropic 协议）',
    draft: {
      protocol: 'anthropic-messages',
      name: 'opencode-zen-claude',
      base_url: 'https://opencode.ai/zen/v1',
      credential: '',
      model: '',
      context_window: 200000,
      max_tokens: 16384,
      vision: true
    },
    credentialPlaceholder: '密钥，或 env:OPENCODE_API_KEY',
    hint: 'OpenCode Zen 上的 Claude 系列模型走 Anthropic 协议；填密钥后点「拉取模型列表」选模型'
  },
  'opencode-go': {
    label: 'OpenCode Go（Coding 订阅）',
    draft: {
      protocol: 'openai-compatible',
      name: 'opencode-go',
      base_url: 'https://opencode.ai/zen/go/v1',
      credential: '',
      model: '',
      context_window: 200000,
      max_tokens: 16384,
      vision: true
    },
    credentialPlaceholder: '密钥，或 env:OPENCODE_API_KEY',
    hint: '适用 OpenCode Go 订阅额度；填密钥后点「拉取模型列表」选模型'
  },
  openrouter: {
    label: 'OpenRouter（多模型聚合）',
    draft: {
      protocol: 'openai-compatible',
      name: 'openrouter',
      base_url: 'https://openrouter.ai/api/v1',
      credential: '',
      model: '',
      context_window: 200000,
      max_tokens: 16384,
      vision: true
    },
    credentialPlaceholder: '密钥，或 env:OPENROUTER_API_KEY'
  },
  openai: {
    label: 'OpenAI 官方',
    draft: {
      protocol: 'openai-compatible',
      name: 'openai',
      base_url: 'https://api.openai.com/v1',
      credential: '',
      model: '',
      context_window: 200000,
      max_tokens: 16384,
      vision: true
    },
    credentialPlaceholder: '密钥，或 env:OPENAI_API_KEY'
  },
  anthropic: {
    label: 'Anthropic Claude 官方',
    draft: {
      protocol: 'anthropic-messages',
      name: 'anthropic',
      base_url: 'https://api.anthropic.com/v1',
      credential: '',
      model: '',
      context_window: 200000,
      max_tokens: 16384,
      vision: true
    },
    credentialPlaceholder: '密钥，或 env:ANTHROPIC_API_KEY'
  },
  gemini: {
    label: 'Google Gemini 官方',
    draft: {
      protocol: 'gemini',
      name: 'gemini',
      base_url: 'https://generativelanguage.googleapis.com/v1beta',
      credential: '',
      model: 'gemini-2.5-flash',
      context_window: 1000000,
      max_tokens: 8192,
      vision: true
    },
    credentialPlaceholder: '密钥，或 env:GEMINI_API_KEY'
  },
  zhipu: {
    label: '智谱 BigModel（按量）',
    draft: {
      protocol: 'openai-compatible',
      name: 'zhipu',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      credential: '',
      model: '',
      context_window: 128000,
      max_tokens: 8192,
      vision: true
    },
    credentialPlaceholder: '密钥，或 env:ZHIPU_API_KEY'
  },
  'zhipu-coding': {
    label: '智谱 GLM Coding Plan（包月编程套餐）',
    draft: {
      protocol: 'openai-compatible',
      name: 'zhipu-coding',
      base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
      credential: '',
      model: '',
      context_window: 128000,
      max_tokens: 8192,
      vision: true
    },
    credentialPlaceholder: 'Coding Plan 专属密钥，或 env:ZHIPU_API_KEY'
  },
  moonshot: {
    label: 'Moonshot · Kimi（国内）',
    draft: {
      protocol: 'openai-compatible',
      name: 'moonshot',
      base_url: 'https://api.moonshot.cn/v1',
      credential: '',
      model: '',
      context_window: 256000,
      max_tokens: 8192,
      vision: true
    },
    credentialPlaceholder: '密钥，或 env:MOONSHOT_API_KEY'
  },
  dashscope: {
    label: '阿里云百炼 · 通义千问',
    draft: {
      protocol: 'openai-compatible',
      name: 'dashscope',
      base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      credential: '',
      model: '',
      context_window: 128000,
      max_tokens: 8192,
      vision: true
    },
    credentialPlaceholder: '密钥，或 env:DASHSCOPE_API_KEY'
  },
  ark: {
    label: '火山方舟 · 豆包 / DeepSeek',
    draft: {
      protocol: 'openai-compatible',
      name: 'ark',
      base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      credential: '',
      model: '',
      context_window: 128000,
      max_tokens: 8192,
      vision: true
    },
    credentialPlaceholder: '密钥，或 env:ARK_API_KEY',
    hint: '模型 ID 填推理接入点（ep-...）或点击「拉取模型列表」'
  },
  'ark-coding': {
    label: '火山方舟 Coding Plan',
    draft: {
      protocol: 'openai-compatible',
      name: 'ark-coding',
      base_url: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      credential: '',
      model: '',
      context_window: 128000,
      max_tokens: 8192,
      vision: true
    },
    credentialPlaceholder: 'Coding Plan 密钥，或 env:ARK_API_KEY'
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow',
    draft: {
      protocol: 'openai-compatible',
      name: 'siliconflow',
      base_url: 'https://api.siliconflow.cn/v1',
      credential: '',
      model: '',
      context_window: 128000,
      max_tokens: 8192,
      vision: true
    },
    credentialPlaceholder: '密钥，或 env:SILICONFLOW_API_KEY'
  },
  minimax: {
    label: 'MiniMax（国内）',
    draft: {
      protocol: 'openai-compatible',
      name: 'minimax',
      base_url: 'https://api.minimaxi.com/v1',
      credential: '',
      model: '',
      context_window: 200000,
      max_tokens: 8192,
      vision: false
    },
    credentialPlaceholder: '密钥，或 env:MINIMAX_API_KEY'
  },
  mimo: {
    label: '小米 MiMo',
    draft: {
      protocol: 'openai-compatible',
      name: 'mimo',
      base_url: 'https://api.xiaomimimo.com/v1',
      credential: '',
      model: '',
      context_window: 128000,
      max_tokens: 8192,
      vision: false
    },
    credentialPlaceholder: '密钥，或 env:MIMO_API_KEY'
  },
  ollama: {
    label: 'Ollama（本机 localhost:11434）',
    draft: {
      protocol: 'openai-compatible',
      name: 'ollama',
      base_url: 'http://127.0.0.1:11434/v1',
      credential: 'ollama',
      model: '',
      context_window: 128000,
      max_tokens: 8192,
      vision: false
    },
    credentialPlaceholder: '本机免密可保留 ollama',
    hint: '本机先启动 Ollama，直接点「拉取模型列表」选择已安装的模型（如支持看图请勾选下方复选框）'
  },
  custom: {
    label: '自定义',
    draft: {
      protocol: 'openai-compatible',
      name: 'my-model',
      base_url: '',
      credential: '',
      model: '',
      context_window: 128000,
      max_tokens: 8192,
      vision: false
    }
  }
} satisfies Record<string, ProviderPreset>

export type PresetId = keyof typeof RAW_PROVIDER_PRESETS
export const PROVIDER_PRESETS: Record<PresetId, ProviderPreset> = RAW_PROVIDER_PRESETS
export const DEFAULT_PRESET: PresetId = 'deepseek-flash'

export const BASE_URL_PLACEHOLDER: Record<ProviderDraft['protocol'], string> = {
  'openai-compatible': 'https://api.deepseek.com/v1',
  'anthropic-messages': 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta'
}
