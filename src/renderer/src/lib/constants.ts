export const TARGET_LANGUAGES = [
  '简体中文',
  '繁體中文',
  'English',
  '日本語',
  '한국어',
  'Français',
  'Deutsch',
  'Español',
  'Русский',
  'Italiano',
  'Português',
  'العربية'
] as const

export const FONT_OPTIONS = [
  {
    value: 'serif' as const,
    label: '宋体 · 长读',
    sample: '读一本好书',
    description: '沉静的衬线字体，适合长时间阅读'
  },
  {
    value: 'sans' as const,
    label: '黑体 · 清晰',
    sample: '读一本好书',
    description: '清晰利落，适合快速浏览'
  },
  {
    value: 'kai' as const,
    label: '楷体 · 温润',
    sample: '读一本好书',
    description: '接近纸面书写的亲切感'
  }
]

export const MODEL_PRESETS = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    modelId: 'gpt-4o-mini'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    modelId: 'deepseek-chat'
  },
  {
    id: 'ollama',
    name: 'Ollama 本地',
    baseUrl: 'http://localhost:11434/v1',
    modelId: 'qwen2.5:7b'
  }
]
