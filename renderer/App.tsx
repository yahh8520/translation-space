import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type RefObject } from 'react'
import { ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleHelp, Copy, Globe2, Languages, LoaderCircle, Maximize2, Minimize2, Minus, Monitor, Pin, Plus, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, X } from 'lucide-react'
import { DEFAULT_CONFIG, DEFAULT_ENDPOINTS, PROVIDERS, type AppConfig, type DesktopBridge, type EngineConfig, type Provider, type SourceLanguage, type TranslationMode, type TranslationResult } from '../shared/types'

declare global { interface Window { desktop?: DesktopBridge } }

const bridge = window.desktop
const providerName = (provider: Provider) => PROVIDERS.find(item => item.value === provider)?.desc ?? provider
const cloneDefaults = () => structuredClone(DEFAULT_CONFIG)
const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。'

/** 弹窗限制键盘焦点，并在关闭时返回触发按钮；测试进行中禁止意外关闭。 */
function useDialogFocus(ref: RefObject<HTMLElement | null>, onClose: () => void, blocked = false) {
  const behavior = useRef({ onClose, blocked })
  behavior.current = { onClose, blocked }
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')).filter(element => element.getClientRects().length > 0)
    ;(dialog.querySelector<HTMLElement>('[data-dialog-focus]') ?? focusable()[0])?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !behavior.current.blocked) { event.preventDefault(); behavior.current.onClose() }
      if (event.key !== 'Tab') return
      const elements = focusable(); const first = elements[0]; const last = elements.at(-1)
      if (!first || !last) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => { document.removeEventListener('keydown', keyboard); previous?.focus() }
  }, [ref])
}

/** 所有原文与结果只存在于当前组件内存中，不写入本地存储。 */
export default function App() {
  const [config, setConfig] = useState<AppConfig>(cloneDefaults)
  const [ready, setReady] = useState(!bridge)
  const [bootError, setBootError] = useState('')
  const [notice, setNotice] = useState('')
  const card = location.hash === '#/card'

  useEffect(() => {
    document.documentElement.dataset.surface = card ? 'card' : 'settings'
    document.title = card ? 'translation-space · 翻译' : 'translation-space · 设置'
    if (!bridge) return
    let mounted = true
    bridge.getConfig().then(result => {
      if (!mounted) return
      if (result.ok) setConfig(result.data)
      else setBootError(result.error.message)
      setReady(true)
    }).catch(error => { if (mounted) { setBootError(messageOf(error)); setReady(true) } })
    const unsubscribe = bridge.onConfigChanged(value => { if (mounted) setConfig(value) })
    return () => { mounted = false; unsubscribe() }
  }, [card])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 4200)
    return () => clearTimeout(timer)
  }, [notice])

  if (!ready) return <div className="boot"><LoaderCircle className="spin" /><span>正在打开 translation-space…</span></div>
  if (bootError) return <div className="boot"><CircleHelp /><h2>暂时无法读取配置</h2><p>{bootError}</p><button className="primary" onClick={() => location.reload()}>重新加载</button></div>

  return <>
    {card
      ? <TranslationCard config={config} onConfig={setConfig} notify={setNotice} />
      : <SettingsPage config={config} onConfig={setConfig} notify={setNotice} />}
    {notice && <div role="status" className={`toast ${card ? 'toast-card' : ''}`}><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice('')}><X size={14} /></button></div>}
  </>
}

function Brand({ compact = false, short = false }: { compact?: boolean; short?: boolean }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><span className="brand-mark"><Languages size={compact ? 15 : 23} /></span><div><strong>{short ? 't-space' : 'translation-space'}</strong>{!compact && <span className="brand-en">A LITTLE SPACE FOR LANGUAGE</span>}</div></div>
}

function EngineIcon({ provider, small = false }: { provider: Provider; small?: boolean }) {
  return <span className={`engine-icon ${provider === 'openai' ? 'engine-ai' : ''} ${small ? 'engine-icon-small' : ''}`}>{provider === 'openai' ? <Sparkles size={small ? 15 : 22} /> : <Languages size={small ? 15 : 22} />}</span>
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange(value: boolean): void; label: string }) {
  return <button type="button" className={`toggle ${checked ? 'active' : ''}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><span /></button>
}

function SettingsPage({ config, onConfig, notify }: { config: AppConfig; onConfig(value: AppConfig): void; notify(message: string): void }) {
  const [section, setSection] = useState<'engines' | 'appearance' | 'about'>('engines')
  const [draft, setDraft] = useState(config)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editor, setEditor] = useState<EngineConfig | null>(null)
  const [adding, setAdding] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  useEffect(() => { if (!dirtyRef.current) setDraft(config) }, [config])

  const update = (next: AppConfig) => { setDraft(next); setDirty(true) }
  const preference = <K extends keyof AppConfig['preferences']>(key: K, value: AppConfig['preferences'][K]) => update({ ...draft, preferences: { ...draft.preferences, [key]: value } })

  /** 保存成功后才进入日常使用，避免把未生效的界面草稿当作已保存配置。 */
  const save = async (showCard: boolean) => {
    if (!bridge) { notify('当前是界面预览，请在桌面应用中保存配置和使用翻译。'); return }
    setSaving(true)
    try {
      const result = await bridge.saveConfig({ ...draft, setupCompleted: true })
      if (!result.ok) { notify(result.error.message); return }
      onConfig(result.data); setDraft(result.data); setDirty(false)
      if (showCard) await bridge.showCard()
      else notify('配置已保存')
    } catch (error) { notify(messageOf(error)) }
    finally { setSaving(false) }
  }

  const remove = (id: string) => {
    if (draft.engines.length === 1) { notify('请至少保留一个翻译引擎。'); return }
    const engines = draft.engines.filter(item => item.id !== id)
    update({ ...draft, engines, defaultEngineId: draft.defaultEngineId === id ? engines[0].id : draft.defaultEngineId })
    setConfirmDelete(null)
  }

  return <div className="settings-shell">
    <aside className="sidebar">
      <div className="sidebar-drag" />
      <Brand />
      <div className="sidebar-caption">你的桌面翻译空间</div>
      <nav aria-label="设置导航">
        <button className={section === 'engines' ? 'selected' : ''} onClick={() => setSection('engines')}><Globe2 size={18} />翻译引擎<ChevronRight size={14} /></button>
        <button className={section === 'appearance' ? 'selected' : ''} onClick={() => setSection('appearance')}><SlidersHorizontal size={18} />悬浮卡片<ChevronRight size={14} /></button>
        <button className={section === 'about' ? 'selected' : ''} onClick={() => setSection('about')}><CircleHelp size={18} />关于 translation-space<ChevronRight size={14} /></button>
      </nav>
      <div className="sidebar-bottom"><span className="little-orbit">中<span>↗</span>EN</span><p>语言之间，<br />留一点轻盈。</p><span className="version-label">DESIGNED FOR YOUR DESKTOP</span></div>
    </aside>
    <main className="settings-main">
      <div className="settings-titlebar"><span>偏好设置</span><div className="titlebar-right"><span className="local-badge"><span />本地配置</span><button className="text-button" onClick={() => save(true)}>打开翻译卡片<ArrowUpRight size={14} /></button></div></div>
      <div className="settings-scroll">
        {(config as AppConfig & { migrationNotice?: string }).migrationNotice && <div className="preview-banner migration-banner"><ShieldCheck size={16} /><span>{(config as AppConfig & { migrationNotice?: string }).migrationNotice}</span></div>}
        {!bridge && <div className="preview-banner"><Monitor size={16} />界面预览模式 · 翻译和配置保存请使用桌面应用。</div>}
        {section === 'engines' && <>
          <header className="page-heading"><span className="eyebrow">TRANSLATION ENGINES</span><h1>{!draft.setupCompleted ? '从这里，连接另一种语言。' : '选一个，适合你的表达。'}</h1><p>日常翻译，开箱即用。更细腻的表达，交给你喜欢的 AI。</p></header>
          {!draft.setupCompleted && <div className="welcome-note"><span className="welcome-icon"><Check size={17} /></span><div><strong>已经为你准备好了</strong><p>内置公共翻译，无需密钥。保存后就可以开始中英互译。</p></div><span className="welcome-number">01 / 02</span></div>}
          <div className="section-heading"><div><h2>我的翻译引擎 <span>{draft.engines.length}</span></h2><p>选中的默认引擎会用于下一次翻译</p></div><button className="secondary" onClick={() => { setEditor(null); setAdding(true) }}><Plus size={16} />添加引擎</button></div>
          <div className="engine-list">
            {draft.engines.map(engine => <div className={`engine-row ${draft.defaultEngineId === engine.id ? 'is-default' : ''}`} key={engine.id}>
              <button className="engine-choice" aria-label={`将${engine.name}设为默认引擎`} aria-pressed={draft.defaultEngineId === engine.id} onClick={() => update({ ...draft, defaultEngineId: engine.id })}><span className={`radio ${draft.defaultEngineId === engine.id ? 'checked' : ''}`} /><EngineIcon provider={engine.provider} /><span className="engine-summary"><span className="engine-name">{engine.name}{draft.defaultEngineId === engine.id && <span className="default-label">默认</span>}</span><span className="engine-description">{engine.provider === 'mymemory' ? '公共服务 · 无需密钥' : engine.provider === 'openai' ? `AI 翻译 · ${engine.model || '待设置模型'}` : `${providerName(engine.provider)} · 自定义配置`}</span></span></button>
              <div className="engine-actions"><button className="icon-button" title="编辑引擎" aria-label={`编辑${engine.name}`} onClick={() => setEditor({ ...engine })}><Settings2 size={17} /></button><button className="icon-button delete-button" title="删除引擎" aria-label={`删除${engine.name}`} disabled={draft.engines.length === 1} onClick={() => setConfirmDelete(engine.id)}><Trash2 size={16} /></button></div>
            </div>)}
          </div>
          <button className="ai-invitation" onClick={() => { setEditor({ id: crypto.randomUUID(), name: '我的 AI 翻译', provider: 'openai', endpoint: DEFAULT_ENDPOINTS.openai, apiKey: '', model: '' }); setAdding(true) }}><span className="ai-orbit"><Sparkles size={24} /></span><span><strong>让翻译，多一分语境。</strong><span>连接 OpenAI 兼容模型，获得多种译法与详细解释。</span></span><ArrowUpRight size={22} /></button>
          <div className="service-footnote"><ShieldCheck size={16} /><p>密钥由操作系统加密保护。原文仅发送至你选择的翻译服务，translation-space 不保存翻译历史。</p></div>
          <div className="subtle-note">MyMemory 匿名额度约 5,000 字符 / 天，服务方可能调整限制。达到额度后可切换自定义引擎。</div>
        </>}
        {section === 'appearance' && <>
          <header className="page-heading"><span className="eyebrow">A QUIET COMPANION</span><h1>刚刚好的存在感。</h1><p>让翻译卡片融入桌面，随时可见，也不喧宾夺主。</p></header>
          <div className="appearance-preview"><div className="preview-desktop-lines" /><div className="mini-card" style={{ background: `rgba(28, 36, 33, ${draft.preferences.backgroundOpacity / 100})` }}><div className="mini-card-heading"><Brand compact /><div><Pin size={13} /><Minus size={14} /></div></div><div className="mini-language">中文 <ArrowRight size={12} /> English</div><p style={{ fontSize: draft.preferences.fontSize }}>在语言之间，自在表达。</p><div className="mini-separator" /><p className="mini-translation" style={{ fontSize: draft.preferences.fontSize }}>Find your words,<br />in another language.</p><span className="preview-tag">外观预览</span></div><span className="preview-coordinate">YOUR DESKTOP, YOUR SPACE.</span></div>
          <div className="preferences-panel">
            <div className="preference-row"><div><strong>始终置顶</strong><p>卡片显示在其他普通窗口之上</p></div><Toggle checked={draft.preferences.alwaysOnTop} onChange={value => preference('alwaysOnTop', value)} label="始终置顶" /></div>
            <div className="preference-row"><div><strong>输入后自动翻译</strong><p>停止输入 0.7 秒后翻译，中文输入法组词时暂停</p></div><Toggle checked={draft.preferences.autoTranslate} onChange={value => preference('autoTranslate', value)} label="输入后自动翻译" /></div>
            <div className="preference-row"><div><strong>使用迷你卡片</strong><p>约 300 × 150，只保留基本输入、译文和复制</p></div><Toggle checked={draft.preferences.compactMode} onChange={value => preference('compactMode', value)} label="使用迷你卡片" /></div>
            <div className="preference-row"><div><strong>启动时显示卡片</strong><p>下次启动直接打开翻译卡片</p></div><Toggle checked={draft.preferences.showCardOnStartup} onChange={value => preference('showCardOnStartup', value)} label="启动时显示卡片" /></div>
            <div className="preference-row slider-row"><div><strong>背景不透明度</strong><p>只改变背景，文字始终清晰</p></div><div className="slider-control"><input aria-label="背景不透明度" type="range" min="45" max="100" value={draft.preferences.backgroundOpacity} onChange={event => preference('backgroundOpacity', Number(event.target.value))} /><output>{draft.preferences.backgroundOpacity}%</output></div></div>
            <div className="preference-row slider-row"><div><strong>翻译字号</strong><p>原文与译文使用相同字号</p></div><div className="slider-control"><input aria-label="翻译字号" type="range" min="13" max="22" value={draft.preferences.fontSize} onChange={event => preference('fontSize', Number(event.target.value))} /><output>{draft.preferences.fontSize}px</output></div></div>
          </div>
          <p className="subtle-note">保存后应用到悬浮卡片。卡片位置和大小会自动记住。</p>
        </>}
        {section === 'about' && <div className="about-page"><span className="eyebrow">A LITTLE SPACE FOR LANGUAGE</span><div className="about-mark">translation<span>-space</span></div><h1>表达，自在一点。</h1><p>一个安静待在桌面上的中英翻译工具。<br />从一句简单的话，到一种更贴切的表达。</p><div className="about-facts"><div><ShieldCheck size={20} /><strong>留在你的设备</strong><p>保存偏好与引擎配置<br />不保存原文或翻译记录</p></div><div><Globe2 size={20} /><strong>连接你的选择</strong><p>公共翻译开箱即用<br />支持自定义翻译与 AI 服务</p></div></div><div className="about-bottom"><span>translation-space</span><span>0.2.0</span></div><p className="about-service-note">翻译文本会发送至所选第三方服务。其额度、可用性与数据处理规则由服务提供方决定。</p></div>}
      </div>
      <footer className="settings-footer"><span className="save-status"><span className={dirty ? 'unsaved-dot' : 'saved-dot'} />{dirty ? '有尚未保存的更改' : '偏好保存在这台设备'}</span><div>{dirty && <button className="text-button" disabled={saving} onClick={() => { setDraft(config); setDirty(false) }}>撤销更改</button>}<button className="primary" disabled={saving} onClick={() => save(!draft.setupCompleted)}>{saving ? <LoaderCircle size={16} className="spin" /> : !draft.setupCompleted ? <ArrowRight size={16} /> : <Check size={16} />}{!draft.setupCompleted ? '保存并打开卡片' : '保存设置'}</button></div></footer>
    </main>
    {(editor || adding) && <EngineEditor engine={editor} adding={adding} notify={notify} onClose={() => { setEditor(null); setAdding(false) }} onSave={engine => { const existing = draft.engines.some(item => item.id === engine.id); update({ ...draft, engines: existing ? draft.engines.map(item => item.id === engine.id ? engine : item) : [...draft.engines, engine] }); setEditor(null); setAdding(false) }} />}
    {confirmDelete && <ConfirmDeleteDialog onClose={() => setConfirmDelete(null)} onConfirm={() => remove(confirmDelete)} />}
  </div>
}

function ConfirmDeleteDialog({ onClose, onConfirm }: { onClose(): void; onConfirm(): void }) {
  const dialog = useRef<HTMLDivElement>(null)
  useDialogFocus(dialog, onClose)
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><div ref={dialog} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title"><span className="dialog-symbol"><Trash2 size={22} /></span><h2 id="delete-title">移除这个翻译引擎？</h2><p>保存设置后，相关配置和密钥会从此设备移除。</p><div className="dialog-actions"><button data-dialog-focus className="secondary" onClick={onClose}>保留</button><button className="danger" onClick={onConfirm}>移除引擎</button></div></div></div>
}

function EngineEditor({ engine, adding, onSave, onClose, notify }: { engine: EngineConfig | null; adding: boolean; onSave(value: EngineConfig): void; onClose(): void; notify(message: string): void }) {
  const [value, setValue] = useState<EngineConfig>(() => engine ?? { id: crypto.randomUUID(), name: '', provider: 'openai', endpoint: DEFAULT_ENDPOINTS.openai, apiKey: '', model: '' })
  const [testing, setTesting] = useState(false)
  const [testMessage, setTestMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [showKey, setShowKey] = useState(false)
  const sameOrigin = (() => {
    try { return engine && new URL(engine.endpoint).origin === new URL(value.endpoint).origin }
    catch { return false }
  })()
  const hasStoredKey = Boolean(value.hasApiKey && sameOrigin)
  const dialog = useRef<HTMLFormElement>(null)
  useDialogFocus(dialog, onClose, testing)
  const change = (patch: Partial<EngineConfig>) => { setValue(current => ({ ...current, ...patch })); setTestMessage(null) }

  const validate = () => {
    if (!value.name.trim()) return '请填写引擎名称。'
    if (!value.endpoint.trim()) return '请填写服务端点。'
    try {
      const endpoint = new URL(value.endpoint.trim())
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
      if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && local)) return '端点请使用 HTTPS；仅本机服务允许 HTTP。'
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return '端点地址不能包含账号、密码、查询参数或锚点，密钥请填写在独立字段。'
    } catch { return '请输入完整有效的端点 URL。' }
    if (value.provider === 'openai' && !value.model?.trim()) return '请填写模型名称。'
    if (['openai', 'microsoft', 'google'].includes(value.provider) && !value.apiKey?.trim() && !hasStoredKey) return value.hasApiKey && !sameOrigin ? '服务地址已更换，请重新填写此服务的 API 密钥。' : '请填写 API 密钥。'
    return ''
  }
  const test = async () => {
    const error = validate(); if (error) { setTestMessage({ ok: false, text: error }); return }
    if (!bridge) { notify('连接测试需要在桌面应用中运行。'); return }
    setTesting(true); setTestMessage(null)
    try { const result = await bridge.testEngine(value); setTestMessage(result.ok ? { ok: true, text: `连接成功 · ${result.data.translations[0] || '已收到译文'}` } : { ok: false, text: result.error.message }) }
    catch (error) { setTestMessage({ ok: false, text: messageOf(error) }) }
    finally { setTesting(false) }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault(); const error = validate()
    if (error) { setTestMessage({ ok: false, text: error }); return }
    onSave({ ...value, name: value.name.trim(), endpoint: value.endpoint.trim(), model: value.model?.trim(), apiKey: value.apiKey?.trim() })
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !testing) onClose() }}><form ref={dialog} className="engine-editor" role="dialog" aria-modal="true" aria-labelledby="editor-title" onSubmit={submit}>
    <div className="editor-heading"><div><span className="eyebrow">MAKE IT YOURS</span><h2 id="editor-title">{adding ? '连接一个新引擎' : '编辑翻译引擎'}</h2></div><button type="button" className="icon-button" disabled={testing} aria-label="关闭编辑" onClick={onClose}><X size={20} /></button></div>
    <div className="editor-fields">
      <label className="field">引擎类型<select value={value.provider} onChange={event => { const provider = event.target.value as Provider; change({ provider, endpoint: DEFAULT_ENDPOINTS[provider], apiKey: '', hasApiKey: false, model: '', region: '', prompt: '', name: value.name || providerName(provider) }) }}>{PROVIDERS.map(item => <option key={item.value} value={item.value}>{item.desc}</option>)}</select></label>
      <label className="field">显示名称<input data-dialog-focus required maxLength={60} value={value.name} onChange={event => change({ name: event.target.value })} placeholder="例如：日常翻译、我的 AI" /></label>
      <label className="field">服务端点 URL<input required type="url" spellCheck={false} value={value.endpoint} onChange={event => change({ endpoint: event.target.value })} placeholder={DEFAULT_ENDPOINTS[value.provider]} /><span className="field-hint">{value.provider === 'openai' ? '支持 API 基础地址或完整的 /chat/completions 地址。' : value.provider === 'libretranslate' ? '填写你使用的实例地址，或完整的 /translate 地址。' : '已预填服务商默认地址，也可以指定兼容的自定义端点。'}</span></label>
      <label className="field"><span>API 密钥{value.provider === 'mymemory' || value.provider === 'libretranslate' ? <small>可选</small> : null}</span><div className="password-field"><input type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={value.apiKey ?? ''} onChange={event => change({ apiKey: event.target.value })} placeholder={hasStoredKey ? '已安全保存，留空保留现有密钥' : '输入服务商提供的密钥'} /><button type="button" onClick={() => setShowKey(!showKey)}>{showKey ? '隐藏' : '显示'}</button></div>{value.hasApiKey && <span className="field-hint">{sameOrigin ? '需要移除已有密钥时，请删除该引擎后重新添加。' : '服务地址已更换，旧密钥不会传给新的服务。'}</span>}</label>
      {value.provider === 'openai' && <><label className="field">模型名称<input required spellCheck={false} value={value.model ?? ''} onChange={event => change({ model: event.target.value })} placeholder="填写服务商支持的模型 ID" /></label><label className="field">补充提示词 <small>可选</small><textarea rows={3} value={value.prompt ?? ''} onChange={event => change({ prompt: event.target.value })} placeholder="例如：使用自然简洁的商务表达，保留专业术语。" /><span className="field-hint">已内置翻译提示词。这里可补充语气或领域偏好。</span></label></>}
      {value.provider === 'microsoft' && <label className="field">资源区域 <small>按资源要求填写</small><input value={value.region ?? ''} onChange={event => change({ region: event.target.value })} placeholder="例如：eastasia；全局资源可留空" /></label>}
      <div className="connection-note"><CircleHelp size={15} /><p>测试会向此服务发送一句测试文本，可能消耗服务额度。原文将发送到你配置的端点。</p></div>
      {testMessage && <div className={`test-result ${testMessage.ok ? 'success' : 'failure'}`} role="status">{testMessage.ok ? <Check size={16} /> : <CircleHelp size={16} />}<span>{testMessage.text}</span></div>}
    </div>
    <div className="editor-footer"><button type="button" className="secondary" disabled={testing} onClick={test}>{testing ? <LoaderCircle size={15} className="spin" /> : <Globe2 size={15} />}{testing ? '正在测试…' : '测试连接'}</button><button className="primary" disabled={testing} type="submit">{adding ? '添加到引擎列表' : '确认修改'}<ArrowRight size={15} /></button></div>
  </form></div>
}

function TranslationCard({ config, onConfig, notify }: { config: AppConfig; onConfig(value: AppConfig): void; notify(message: string): void }) {
  const [engineId, setEngineId] = useState(config.defaultEngineId)
  const [text, setText] = useState('')
  const [source, setSource] = useState<SourceLanguage>('auto')
  const [mode, setMode] = useState<TranslationMode>('standard')
  const [result, setResult] = useState<TranslationResult | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [composingState, setComposingState] = useState(false)
  const [visible, setVisible] = useState(!bridge && document.visibilityState === 'visible')
  const [copied, setCopied] = useState<string | null>(null)
  const [explanationOpen, setExplanationOpen] = useState(true)
  const [changingEngine, setChangingEngine] = useState(false)
  const [pinning, setPinning] = useState(false)
  const [resizing, setResizing] = useState(false)
  const generation = useRef(0)
  const activeRequest = useRef<string | null>(null)
  const composing = useRef(false)
  const visibleRef = useRef(!bridge && document.visibilityState === 'visible')
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAttempt = useRef<string | null>(null)
  const canceledSignature = useRef<string | null>(null)
  const engine = config.engines.find(item => item.id === engineId) ?? config.engines[0]
  const compact = config.preferences.compactMode
  const automatic = config.preferences.autoTranslate
  const signature = JSON.stringify([text, source, mode, engineId, engine])
  const snapshot = useRef({ text, source, mode, engine, compact, changingEngine, signature })
  snapshot.current = { text, source, mode, engine, compact, changingEngine, signature }

  const stopDebounce = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = null
    setWaiting(false)
  }, [])

  const invalidate = useCallback((preserveResult = false) => {
    stopDebounce()
    generation.current += 1
    if (activeRequest.current && bridge) void bridge.cancelTranslation(activeRequest.current).catch(() => {})
    activeRequest.current = null
    setLoading(false)
    if (!preserveResult) { setResult(null); setError('') }
  }, [stopDebounce])

  /** 手动触发和自动触发共用同步请求锁，停止输入的定时器不能发起第二个请求。 */
  const translate = useCallback(async (fromAutomatic = false) => {
    stopDebounce()
    const currentInput = snapshot.current
    if (!currentInput.text.trim() || activeRequest.current || currentInput.changingEngine || composing.current || !visibleRef.current) return
    if (fromAutomatic && (lastAttempt.current === currentInput.signature || canceledSignature.current === currentInput.signature)) return
    lastAttempt.current = currentInput.signature
    if (!bridge) { setError('当前是界面预览，请打开桌面应用使用翻译。'); return }
    const requestId = crypto.randomUUID()
    const current = ++generation.current
    activeRequest.current = requestId; setLoading(true); setResult(null); setError('')
    try {
      const response = await bridge.translate({
        requestId,
        engineId: currentInput.engine.id,
        text: currentInput.text,
        source: currentInput.compact ? 'auto' : currentInput.source,
        mode: !currentInput.compact && currentInput.engine.provider === 'openai' ? currentInput.mode : 'standard',
      })
      if (current !== generation.current) return
      if (response.ok) { setResult(response.data); setExplanationOpen(true) }
      else if (response.error.code !== 'CANCELED') setError(response.error.message)
    } catch (reason) { if (current === generation.current) setError(messageOf(reason)) }
    finally { if (current === generation.current) { setLoading(false); activeRequest.current = null } }
  }, [stopDebounce])

  useEffect(() => { setEngineId(config.defaultEngineId) }, [config.defaultEngineId])

  /** 只有翻译输入变化才使结果过期；切换卡片大小、置顶或透明度保留原文和结果。 */
  useEffect(() => {
    invalidate()
    lastAttempt.current = null
    canceledSignature.current = null
  }, [signature, invalidate])

  /** 用户确认（2026-11-11）：停输入后自动翻译；组词期间暂停，完成后重新等待 700ms。 */
  useEffect(() => {
    if (!automatic || !visible || composingState || changingEngine || !text.trim() || lastAttempt.current === signature || canceledSignature.current === signature) return
    setWaiting(true)
    debounceTimer.current = setTimeout(() => { debounceTimer.current = null; void translate(true) }, 700)
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      debounceTimer.current = null
      setWaiting(false)
    }
  }, [signature, automatic, visible, composingState, changingEngine, text, translate])

  /** 桌面窗口以原生可见性为准；隐藏立即停请求，恢复显示仍保留用户显式取消。 */
  useEffect(() => {
    const applyVisibility = (nextVisible: boolean) => {
      visibleRef.current = nextVisible
      if (!nextVisible) {
        if (activeRequest.current && canceledSignature.current !== snapshot.current.signature) lastAttempt.current = null
        invalidate(true)
      }
      setVisible(nextVisible)
    }
    if (bridge) {
      let subscribed = true
      const unsubscribe = bridge.onCardVisibilityChanged(value => { if (subscribed) applyVisibility(value) })
      return () => { subscribed = false; unsubscribe() }
    }
    const visibilityChanged = () => applyVisibility(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', visibilityChanged)
    visibilityChanged()
    return () => document.removeEventListener('visibilitychange', visibilityChanged)
  }, [invalidate])

  useEffect(() => () => {
    generation.current++
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    if (activeRequest.current && bridge) void bridge.cancelTranslation(activeRequest.current).catch(() => {})
  }, [])
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(null), 1600); return () => clearTimeout(timer) }, [copied])

  /** 取消锁定当前输入，直到用户修改输入或显式点击翻译，防止自动立即重启。 */
  const cancel = () => {
    canceledSignature.current = snapshot.current.signature
    lastAttempt.current = snapshot.current.signature
    invalidate()
  }
  const changeText = (value: string) => { invalidate(); setText(value) }
  const copy = async (value: string, id: string) => {
    if (!bridge) { notify('复制功能请在桌面应用中使用。'); return }
    try { await bridge.copyText(value); setCopied(id) } catch (reason) { notify(messageOf(reason)) }
  }
  const switchEngine = async (id: string) => {
    if (!bridge) { invalidate(); setEngineId(id); return }
    invalidate(); setEngineId(id); setChangingEngine(true)
    try {
      const latest = await bridge.getConfig()
      if (!latest.ok) { notify(latest.error.message); setEngineId(config.defaultEngineId); return }
      const saved = await bridge.saveConfig({ ...latest.data, defaultEngineId: id })
      if (saved.ok) onConfig(saved.data)
      else { notify(saved.error.message); setEngineId(config.defaultEngineId) }
    } catch (reason) { notify(messageOf(reason)); setEngineId(config.defaultEngineId) }
    finally { setChangingEngine(false) }
  }
  const pin = async () => {
    if (!bridge) { notify('置顶功能请在桌面应用中使用。'); return }
    setPinning(true)
    try { const saved = await bridge.setAlwaysOnTop(!config.preferences.alwaysOnTop); if (saved.ok) onConfig(saved.data); else notify(saved.error.message) }
    catch (reason) { notify(messageOf(reason)) }
    finally { setPinning(false) }
  }
  const toggleCompact = async () => {
    if (!bridge) { notify('卡片切换请在桌面应用中使用。'); return }
    setResizing(true)
    try { const saved = await bridge.setCompactMode(!compact); if (saved.ok) onConfig(saved.data); else notify(saved.error.message) }
    catch (reason) { notify(messageOf(reason)) }
    finally { setResizing(false) }
  }
  const action = async (name: 'openSettings' | 'hideCard') => {
    if (!bridge) { notify('窗口操作请在桌面应用中使用。'); return }
    try { await bridge[name]() } catch (reason) { notify(messageOf(reason)) }
  }

  const engineSelect = <span className="engine-select"><EngineIcon provider={engine.provider} small /><select aria-label="当前翻译引擎" value={engine.id} disabled={changingEngine} onChange={event => switchEngine(event.target.value)}>{config.engines.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={12} /></span>

  return <div className={`translation-window ${compact ? 'is-compact' : ''}`} style={{ '--card-opacity': config.preferences.backgroundOpacity / 100, '--translation-font-size': `${config.preferences.fontSize}px` } as CSSProperties}>
    <header className="card-topbar"><span className="card-drag-brand"><Brand compact short={compact} /></span>{compact && engineSelect}<div className="card-window-actions"><button className="icon-button" disabled={resizing} aria-label={compact ? '展开标准卡片' : '切换迷你卡片'} title={compact ? '展开标准卡片' : '迷你卡片'} onClick={toggleCompact}>{compact ? <Maximize2 size={13} /> : <Minimize2 size={15} />}</button><button className={`icon-button ${config.preferences.alwaysOnTop ? 'pinned' : ''}`} disabled={pinning} aria-label={config.preferences.alwaysOnTop ? '取消置顶' : '置顶卡片'} title={config.preferences.alwaysOnTop ? '已置顶' : '置顶'} onClick={pin}><Pin size={compact ? 12 : 15} /></button>{!compact && <button className="icon-button" aria-label="打开设置" title="设置" onClick={() => action('openSettings')}><Settings2 size={16} /></button>}<button className="icon-button" aria-label="隐藏卡片" title="隐藏到菜单栏或托盘" onClick={() => action('hideCard')}><Minus size={compact ? 14 : 18} /></button></div></header>
    <div className="card-body">
      {!compact && <div className="card-engine-row">{engineSelect}<span className="engine-kind">{engine.provider === 'openai' ? 'AI 翻译' : '普通翻译'}</span></div>}
      {!compact && <div className="input-toolbar"><select aria-label="翻译方向" value={source} onChange={event => { invalidate(); setSource(event.target.value as SourceLanguage) }}><option value="auto">自动识别 · 中 / 英</option><option value="zh">中文 → English</option><option value="en">English → 中文</option></select>{text && <button className="clear-input" onClick={() => changeText('')}>清空</button>}</div>}
      <div className="input-area"><textarea className="translation-input" aria-label="待翻译文本" placeholder={compact ? automatic ? '输入文字，自动中英互译…' : '输入文字，点箭头翻译…' : '输入或粘贴一句话…'} value={text} maxLength={10000} spellCheck={false} onChange={event => changeText(event.target.value)} onCompositionStart={() => { composing.current = true; setComposingState(true); lastAttempt.current = null; invalidate() }} onCompositionEnd={event => { composing.current = false; setText(event.currentTarget.value); setComposingState(false) }} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && !composing.current) { event.preventDefault(); void translate() } }} />{compact && <button className="compact-translate" disabled={(!text.trim() || changingEngine) && !loading} title={loading ? '取消翻译' : '立即翻译'} aria-label={loading ? '取消翻译' : '立即翻译'} onClick={() => loading ? cancel() : void translate()}>{loading ? <X size={12} /> : waiting ? <span className="compact-wait-dot" /> : <ArrowRight size={13} />}</button>}</div>
      {!compact && <div className="input-bottom"><span className="input-count">{waiting ? '停止输入后自动翻译…' : automatic ? '输入后自动翻译 · ⌘ / Ctrl + Enter 立即翻译' : text.length ? `${text.length.toLocaleString()} / 10,000 字符` : '⌘ / Ctrl + Enter 翻译'}</span>{loading ? <button className="translate-button cancel-button" onClick={cancel}><X size={14} />取消</button> : <button className="translate-button" disabled={!text.trim() || changingEngine} onClick={() => void translate()}>翻译<ArrowRight size={15} /></button>}</div>}
      {!compact && <div className="result-divider"><span />{engine.provider === 'openai' ? <div className="mode-switch" aria-label="AI 翻译模式"><button className={mode === 'standard' ? 'active' : ''} onClick={() => { if (mode !== 'standard') { invalidate(); setMode('standard') } }}>标准</button><button className={mode === 'detailed' ? 'active' : ''} onClick={() => { if (mode !== 'detailed') { invalidate(); setMode('detailed') } }}>详细</button></div> : <span className="direct-label">译文</span>}<span /></div>}
      <section className="results" aria-live="polite" aria-busy={loading}>
        {loading && (compact ? <div className="compact-status"><LoaderCircle size={12} className="spin" /><span>正在翻译…</span></div> : <div className="translation-loading"><div className="loading-orbit"><Languages size={26} /></div><p>正在寻找贴切的表达<span className="animated-dots">…</span></p><span>文字正在另一种语言里，慢慢展开</span></div>)}
        {error && (compact ? <div className="compact-error"><CircleHelp size={12} /><p title={error}>{error}</p><button title="重新翻译" aria-label="重新翻译" onClick={() => void translate()}><ArrowRight size={13} /></button></div> : <div className="translation-error"><CircleHelp size={24} /><strong>这次翻译没有完成</strong><p>{error}</p><button className="card-retry" onClick={() => void translate()}>重新翻译<ArrowRight size={14} /></button></div>)}
        {!loading && !error && result && <>{!compact && <div className="result-language">{result.target === 'zh' ? '简体中文' : 'ENGLISH'}<span>{result.engineName}</span></div>}{result.translations.map((translation, index) => <article className="translation-variant" key={index}>{!compact && result.translations.length > 1 && <span className="variant-number">{String(index + 1).padStart(2, '0')}</span>}<p>{translation}</p><button className={`copy-button ${copied === `translation-${index}` ? 'copied' : ''}`} aria-label={`复制${result.translations.length > 1 ? `第${index + 1}种` : ''}译文`} title="复制译文" onClick={() => copy(translation, `translation-${index}`)}>{copied === `translation-${index}` ? <Check size={compact ? 12 : 15} /> : <Copy size={compact ? 12 : 15} />}</button></article>)}{!compact && result.explanation && <div className="explanation"><button className="explanation-toggle" aria-expanded={explanationOpen} onClick={() => setExplanationOpen(!explanationOpen)}><Sparkles size={14} />关于这次表达<ChevronDown size={14} className={explanationOpen ? '' : 'closed'} /></button>{explanationOpen && <><p>{result.explanation}</p><button className="explanation-copy" onClick={() => copy(result.explanation!, 'explanation')}>{copied === 'explanation' ? <Check size={12} /> : <Copy size={12} />}{copied === 'explanation' ? '已复制解释' : '复制解释'}</button></>}</div>}</>}
        {!loading && !error && !result && (compact ? <div className="compact-placeholder">{composingState ? '输入完成后开始翻译' : waiting ? '即将翻译…' : '译文将在这里显示'}</div> : <div className="result-empty"><span className="empty-symbol">A<span>文</span></span><p>在两种语言之间，<br />找到你的表达。</p><span>译文将显示在这里</span></div>)}
      </section>
    </div>
    {!compact && <footer className="card-footer"><span className="card-status-dot" />{loading ? '正在翻译' : automatic ? '自动翻译 · 不保存历史' : '中英互译 · 不保存历史'}<span className="card-footer-brand">translation-space</span></footer>}
  </div>
}
