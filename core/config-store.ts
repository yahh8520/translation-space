import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { DEFAULT_CONFIG, type AppConfig, type EngineConfig, type FailureCode } from '../shared/types'

export class StoreError extends Error {
  /** 面向界面的稳定错误分类。 */
  readonly code: FailureCode
  constructor(code: FailureCode, message: string) { super(message); this.code = code }
}

/** 密钥保护由 Electron 的系统加密能力提供，测试时注入独立替身。 */
export interface SecretCipher {
  encrypt(value: string): Promise<string>
  decrypt(value: string): Promise<string>
}

const engineSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  name: z.string().trim().min(1).max(80),
  provider: z.enum(['mymemory', 'microsoft', 'google', 'libretranslate', 'openai']),
  endpoint: z.string().trim().min(1).max(2048).refine(value => {
    try {
      const url = new URL(value)
      return !url.username && !url.password && !url.hash && !url.search &&
        (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    } catch { return false }
  }),
  apiKey: z.string().trim().max(8192).optional(),
  hasApiKey: z.boolean().optional(),
  model: z.string().trim().max(200).optional(),
  region: z.string().trim().max(100).optional(),
  prompt: z.string().max(8000).optional(),
})

const configSchema = z.object({
  version: z.literal(1),
  setupCompleted: z.boolean(),
  defaultEngineId: z.string(),
  engines: z.array(engineSchema).min(1).max(20),
  preferences: z.object({
    alwaysOnTop: z.boolean(),
    backgroundOpacity: z.number().finite().min(45).max(100),
    showCardOnStartup: z.boolean(),
    fontSize: z.number().int().min(13).max(22),
    compactMode: z.boolean().default(false),
    autoTranslate: z.boolean().default(true),
  }),
}).refine(value => new Set(value.engines.map(engine => engine.id)).size === value.engines.length)
  .refine(value => value.engines.some(engine => engine.id === value.defaultEngineId))

const boundsSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().min(360).max(1400), height: z.number().min(460).max(1600) })
const compactBoundsSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().min(260).max(600), height: z.number().min(130).max(300) })
export type CardBounds = z.infer<typeof boundsSchema>

/** 只接受已支持的服务商和安全端点，防止畸形 IPC 数据进入主进程。 */
export function validateEngine(value: unknown): EngineConfig {
  const parsed = engineSchema.safeParse(value)
  if (!parsed.success) throw new StoreError('VALIDATION', '引擎配置不完整，请检查名称和端点。端点须为 HTTPS（本机服务可用 HTTP），不要携带查询参数或密钥。')
  return parsed.data
}

export function validateConfig(value: unknown): AppConfig {
  const parsed = configSchema.safeParse(value)
  if (!parsed.success) throw new StoreError('VALIDATION', '配置无效：请保留至少一个引擎，选择有效默认引擎，并检查端点和卡片参数。')
  return parsed.data
}

interface StoredState { config: AppConfig; secrets: Record<string, string>; cardBounds?: CardBounds; compactBounds?: CardBounds }

/** 密钥只属于同一引擎、服务商和源站；修改域名、端口或协议后必须重新填写。 */
function canReuseSecret(previous: EngineConfig, next: EngineConfig): boolean {
  return previous.id === next.id && previous.provider === next.provider &&
    new URL(previous.endpoint).origin === new URL(next.endpoint).origin
}

/** 原子保存偏好和加密密钥；持久化结构刻意不接收任何翻译文本。 */
export class ConfigStore {
  private state: StoredState = { config: structuredClone(DEFAULT_CONFIG), secrets: {} }
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly filename: string, private readonly cipher: SecretCipher) {}

  /** 配置损坏时保留原文件并报告错误，禁止静默覆盖用户配置。 */
  async load(): Promise<void> {
    let content: string
    try { content = await readFile(this.filename, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new StoreError('STORAGE', '无法读取配置文件，请检查文件权限。')
    }
    try {
      const parsed = z.object({ config: configSchema, secrets: z.record(z.string(), z.string().max(32768)), cardBounds: boundsSchema.optional(), compactBounds: compactBoundsSchema.optional() }).parse(JSON.parse(content))
      if (parsed.config.engines.some(engine => engine.apiKey)) throw new Error('明文密钥不允许持久化')
      this.state = parsed
    } catch { throw new StoreError('STORAGE', '配置文件无法解析，原文件已保留。请备份或修复 config.json 后重新启动。') }
  }

  getPublicConfig(): AppConfig {
    const config = structuredClone(this.state.config)
    config.engines = config.engines.map(engine => ({ ...engine, apiKey: '', hasApiKey: Boolean(this.state.secrets[engine.id]) }))
    return config
  }

  getCardBounds(compact = false): CardBounds | undefined {
    const bounds = compact ? this.state.compactBounds : this.state.cardBounds
    return bounds ? { ...bounds } : undefined
  }

  /** 同源编辑时密钥留空表示保留；切换服务商或源站时不继承旧密钥。 */
  async resolveEngine(value: unknown): Promise<EngineConfig> {
    const engine = validateEngine(value)
    if (engine.apiKey) return engine
    const previous = this.state.config.engines.find(item => canReuseSecret(item, engine))
    const encrypted = previous && this.state.secrets[engine.id]
    if (!encrypted) return { ...engine, apiKey: '' }
    try { return { ...engine, apiKey: await this.cipher.decrypt(encrypted) } }
    catch { throw new StoreError('STORAGE', '无法从系统密钥存储解密此密钥，请编辑引擎并重新填写。') }
  }

  async getEngine(id: string): Promise<EngineConfig> {
    const engine = this.state.config.engines.find(item => item.id === id)
    if (!engine) throw new StoreError('VALIDATION', '该翻译引擎已被删除，请重新选择。')
    return this.resolveEngine(engine)
  }

  async save(value: unknown): Promise<AppConfig> {
    const config = validateConfig(value)
    return this.serialize(async () => {
      const secrets: Record<string, string> = {}
      for (const engine of config.engines) {
        if (engine.apiKey) {
          try { secrets[engine.id] = await this.cipher.encrypt(engine.apiKey) }
          catch { throw new StoreError('STORAGE', '系统密钥保护暂不可用，配置未保存。请允许钥匙串访问后重试。') }
        } else if (this.state.config.engines.some(item => canReuseSecret(item, engine)) && this.state.secrets[engine.id]) {
          secrets[engine.id] = this.state.secrets[engine.id]
        }
      }
      const clean = { ...config, engines: config.engines.map(({ apiKey: _key, hasApiKey: _has, ...engine }) => engine) }
      await this.persist({ ...this.state, config: clean, secrets })
      return this.getPublicConfig()
    })
  }

  /** 单项快捷操作在队列内部读取最新配置，避免覆盖另一窗口刚保存的修改。 */
  async setAlwaysOnTop(value: boolean): Promise<AppConfig> {
    return this.serialize(async () => {
      const next = structuredClone(this.state)
      next.config.preferences.alwaysOnTop = value
      await this.persist(next)
      return this.getPublicConfig()
    })
  }

  /** 两种卡片分别保存位置与尺寸，缩小后展开可以恢复原来的标准窗口。 */
  async setCompactMode(value: boolean): Promise<AppConfig> {
    return this.serialize(async () => {
      const next = structuredClone(this.state)
      next.config.preferences.compactMode = value
      await this.persist(next)
      return this.getPublicConfig()
    })
  }

  async saveCardBounds(bounds: CardBounds, compact = false): Promise<void> {
    const parsed = (compact ? compactBoundsSchema : boundsSchema).safeParse(bounds)
    if (!parsed.success) return
    await this.serialize(() => this.persist({ ...this.state, [compact ? 'compactBounds' : 'cardBounds']: parsed.data }))
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.writes.then(operation, operation)
    this.writes = task.catch(() => undefined)
    return task
  }

  private async persist(state: StoredState): Promise<void> {
    try {
      await mkdir(dirname(this.filename), { recursive: true })
      await writeFile(`${this.filename}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 })
      await rename(`${this.filename}.tmp`, this.filename)
      this.state = state
    } catch { throw new StoreError('STORAGE', '无法保存配置，请检查磁盘空间和文件权限。') }
  }
}
