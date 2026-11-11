export type Provider = 'mymemory' | 'microsoft' | 'google' | 'libretranslate' | 'openai'
export type Language = 'zh' | 'en'
export type SourceLanguage = 'auto' | Language
export type TranslationMode = 'standard' | 'detailed'

/** 引擎配置；界面读到的密钥始终为空，hasApiKey 表示系统已安全保存。 */
export interface EngineConfig {
  id: string
  name: string
  provider: Provider
  endpoint: string
  apiKey?: string
  hasApiKey?: boolean
  model?: string
  region?: string
  prompt?: string
}

/** 仅保存软件偏好，不保存原文或翻译结果。 */
export interface AppConfig {
  version: 1
  setupCompleted: boolean
  defaultEngineId: string
  engines: EngineConfig[]
  preferences: {
    alwaysOnTop: boolean
    backgroundOpacity: number
    showCardOnStartup: boolean
    fontSize: number
    compactMode: boolean
    autoTranslate: boolean
  }
}

export interface TranslationRequest {
  requestId: string
  engineId: string
  text: string
  source: SourceLanguage
  mode: TranslationMode
}

export interface TranslationResult {
  source: Language
  target: Language
  translations: string[]
  explanation?: string
  engineName: string
}

export type FailureCode = 'VALIDATION' | 'AUTH' | 'QUOTA' | 'NETWORK' | 'TIMEOUT' | 'CANCELED' | 'PROVIDER' | 'STORAGE'

/** IPC 使用可序列化结果传递错误，不将服务商响应或密钥传入日志。 */
export type Outcome<T> = { ok: true; data: T } | { ok: false; error: { code: FailureCode; message: string } }

export interface DesktopBridge {
  getConfig(): Promise<Outcome<AppConfig>>
  saveConfig(config: AppConfig): Promise<Outcome<AppConfig>>
  translate(request: TranslationRequest): Promise<Outcome<TranslationResult>>
  cancelTranslation(requestId: string): Promise<void>
  testEngine(engine: EngineConfig): Promise<Outcome<TranslationResult>>
  showCard(): Promise<void>
  openSettings(): Promise<void>
  hideCard(): Promise<void>
  setAlwaysOnTop(value: boolean): Promise<Outcome<AppConfig>>
  setCompactMode(value: boolean): Promise<Outcome<AppConfig>>
  copyText(text: string): Promise<void>
  quit(): Promise<void>
  onConfigChanged(callback: (config: AppConfig) => void): () => void
  onCardVisibilityChanged(callback: (visible: boolean) => void): () => void
}

export const PROVIDERS: { value: Provider; desc: string }[] = [
  { value: 'mymemory', desc: 'MyMemory 公共翻译' },
  { value: 'microsoft', desc: '微软翻译' },
  { value: 'google', desc: 'Google 翻译' },
  { value: 'libretranslate', desc: 'LibreTranslate' },
  { value: 'openai', desc: 'AI · OpenAI 兼容' },
]

/** 用户确认（2026-11-11）：默认公共服务、中英互译、可置顶悬浮卡片。 */
export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  setupCompleted: false,
  defaultEngineId: 'public-mymemory',
  engines: [{ id: 'public-mymemory', name: 'MyMemory 公共翻译', provider: 'mymemory', endpoint: 'https://api.mymemory.translated.net/get' }],
  preferences: { alwaysOnTop: true, backgroundOpacity: 92, showCardOnStartup: true, fontSize: 15, compactMode: false, autoTranslate: true },
}

export const DEFAULT_ENDPOINTS: Record<Provider, string> = {
  mymemory: 'https://api.mymemory.translated.net/get',
  microsoft: 'https://api.cognitive.microsofttranslator.com',
  google: 'https://translation.googleapis.com/language/translate/v2',
  libretranslate: 'https://libretranslate.com',
  openai: 'https://api.openai.com/v1',
}
