import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, safeStorage, screen, Tray, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { ConfigStore, StoreError, type CardBounds } from '../core/config-store'
import { translateText, TranslationError } from '../core/translation'
import type { AppConfig, FailureCode, Outcome } from '../shared/types'

let settingsWindow: BrowserWindow | null = null
let cardWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let boundsTimer: ReturnType<typeof setTimeout> | undefined
let store: ConfigStore
let cardCompact = false
const requests = new Map<string, { owner: number; controller: AbortController }>()
const devURL = !app.isPackaged ? process.env.BETWEEN_DEV_URL : undefined
const appPage = pathToFileURL(join(__dirname, '../dist/index.html')).href

// 自动化测试使用独立数据目录，不触碰用户的真实配置。
if (!app.isPackaged && process.env.BETWEEN_USER_DATA) app.setPath('userData', process.env.BETWEEN_USER_DATA)
// 产品改名后继续使用既有存储身份，保证旧配置和系统加密密钥仍可读取。
app.setName('译间')

/** 只接受自身顶层页面的调用，远程导航不能借用桌面权限。 */
function assertSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame
  const url = frame?.url.split('#')[0]
  const trusted = frame && frame === event.sender.mainFrame &&
    (url === appPage || (devURL && url === `${devURL}/`)) &&
    [settingsWindow?.webContents.id, cardWindow?.webContents.id].includes(event.sender.id)
  if (!trusted) throw new StoreError('VALIDATION', '无法识别的应用页面。')
}

async function outcome<T>(operation: () => Promise<T> | T): Promise<Outcome<T>> {
  try { return { ok: true, data: await operation() } }
  catch (error) {
    if (error instanceof StoreError || error instanceof TranslationError) return { ok: false, error: { code: error.code, message: error.message } }
    return { ok: false, error: { code: 'PROVIDER' as FailureCode, message: '操作未完成，请重试。' } }
  }
}

function broadcast(config: AppConfig): void {
  cardWindow?.setAlwaysOnTop(config.preferences.alwaysOnTop)
  applyCardMode(config.preferences.compactMode)
  for (const window of [cardWindow, settingsWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('config:changed', config)
  }
  updateTray()
}

/** 所有页面使用本地资源；阻止弹窗、远程导航和非必要系统权限。 */
function secureWindow(window: BrowserWindow): void {
  const ownerId = window.webContents.id
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, target) => {
    if (target.split('#')[0] !== window.webContents.getURL().split('#')[0]) event.preventDefault()
  })
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  window.webContents.on('destroyed', () => {
    for (const [key, request] of requests) {
      if (request.owner === ownerId) { request.controller.abort(); requests.delete(key) }
    }
  })
}

function loadPage(window: BrowserWindow, page: 'settings' | 'card'): void {
  if (devURL) void window.loadURL(`${devURL}/#/${page}`)
  else void window.loadFile(join(__dirname, '../dist/index.html'), { hash: `/${page}` })
}

function showSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return }
  settingsWindow = new BrowserWindow({
    title: 'translation-space · 设置', width: 1080, height: 780, minWidth: 820, minHeight: 620,
    show: false, backgroundColor: '#f6f5f0', autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: join(app.getAppPath(), 'assets/icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  })
  const window = settingsWindow
  secureWindow(window)
  loadPage(window, 'settings')
  window.once('ready-to-show', () => window.show())
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide() } })
  window.on('closed', () => { settingsWindow = null })
}

/** 显示器变更后把窗口限制在当前可见工作区，防止悬浮卡片无法找回。 */
function visibleBounds(saved?: CardBounds, compact = false): CardBounds {
  const workArea = saved ? screen.getDisplayMatching(saved).workArea : screen.getPrimaryDisplay().workArea
  const width = Math.min(saved?.width ?? (compact ? 300 : 440), workArea.width)
  const height = Math.min(saved?.height ?? (compact ? 150 : 680), workArea.height)
  return {
    width, height,
    x: Math.max(workArea.x, Math.min(saved?.x ?? workArea.x + workArea.width - width - 32, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(saved?.y ?? workArea.y + 70, workArea.y + workArea.height - height)),
  }
}

/** 先解除旧尺寸约束再缩放；两个模式复用同一个页面，不丢失原文和译文。 */
function applyCardMode(compact: boolean): void {
  if (!cardWindow || cardWindow.isDestroyed() || compact === cardCompact) return
  clearTimeout(boundsTimer)
  const previous = cardWindow.getBounds()
  void store.saveCardBounds(previous, cardCompact).catch(() => undefined)
  const saved = store.getCardBounds(compact)
  cardCompact = compact
  cardWindow.setMinimumSize(0, 0)
  cardWindow.setMaximumSize(1400, 1600)
  cardWindow.setResizable(!compact)
  cardWindow.setBounds(visibleBounds(saved ?? { ...previous, width: compact ? 300 : 440, height: compact ? 150 : 680 }, compact))
  cardWindow.setMinimumSize(compact ? 260 : 360, compact ? 130 : 460)
  cardWindow.setMaximumSize(compact ? 600 : 1400, compact ? 300 : 1600)
}

function showCard(): void {
  if (cardWindow && !cardWindow.isDestroyed()) {
    cardWindow.setBounds(visibleBounds(cardWindow.getBounds(), cardCompact))
    cardWindow.show(); cardWindow.focus(); return
  }
  cardCompact = store.getPublicConfig().preferences.compactMode
  cardWindow = new BrowserWindow({
    ...visibleBounds(store.getCardBounds(cardCompact), cardCompact), minWidth: cardCompact ? 260 : 360, minHeight: cardCompact ? 130 : 460, maxWidth: cardCompact ? 600 : 1400, maxHeight: cardCompact ? 300 : 1600,
    title: 'translation-space · 翻译', frame: false, transparent: true, backgroundColor: '#00000000',
    show: false, resizable: !cardCompact, hasShadow: true, roundedCorners: true,
    alwaysOnTop: store.getPublicConfig().preferences.alwaysOnTop,
    icon: join(app.getAppPath(), 'assets/icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  })
  const window = cardWindow
  secureWindow(window)
  const notifyVisibility = () => {
    const visible = window.isVisible() && !window.isMinimized()
    window.webContents.send('window:visibility', visible)
    if (!visible) {
      for (const request of requests.values()) if (request.owner === window.webContents.id) request.controller.abort()
    }
  }
  window.on('show', notifyVisibility)
  window.on('hide', notifyVisibility)
  window.on('minimize', notifyVisibility)
  window.on('restore', notifyVisibility)
  loadPage(window, 'card')
  window.once('ready-to-show', () => window.show())
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide() } })
  const rememberBounds = () => {
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      if (!window.isDestroyed()) void store.saveCardBounds(window.getBounds(), cardCompact).catch(() => undefined)
    }, 400)
  }
  window.on('move', rememberBounds)
  window.on('resize', rememberBounds)
  window.on('closed', () => { cardWindow = null })
}

function updateTray(): void {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: '打开翻译卡片', click: showCard },
    { label: '设置', click: showSettings },
    { type: 'separator' },
    { label: '卡片置顶', type: 'checkbox', checked: store.getPublicConfig().preferences.alwaysOnTop, click: item => {
      void outcome(async () => { const config = await store.setAlwaysOnTop(item.checked); broadcast(config) })
    } },
    { type: 'separator' },
    { label: '退出 translation-space', click: () => app.quit() },
  ]))
}

const requestSchema = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), engineId: z.string().max(80),
  text: z.string().min(1).max(20000), source: z.enum(['auto', 'zh', 'en']), mode: z.enum(['standard', 'detailed']),
})

/** 请求按调用窗口隔离，并限制并发；取消只影响该窗口自己的请求。 */
async function runRequest<T>(event: IpcMainInvokeEvent, id: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const key = `${event.sender.id}:${id}`
  if (requests.has(key)) throw new StoreError('VALIDATION', '请求编号重复，请重试。')
  if ([...requests.values()].filter(request => request.owner === event.sender.id).length >= 4) throw new StoreError('VALIDATION', '请求过于频繁，请等待当前翻译完成。')
  const controller = new AbortController()
  requests.set(key, { owner: event.sender.id, controller })
  try { return await operation(controller.signal) } finally { requests.delete(key) }
}

function registerIPC(): void {
  const handle = (channel: string, handler: (event: IpcMainInvokeEvent, value: unknown) => unknown) => {
    ipcMain.handle(channel, (event, value) => { assertSender(event); return handler(event, value) })
  }
  handle('config:get', () => outcome(() => store.getPublicConfig()))
  handle('config:save', (_event, value) => outcome(async () => { const config = await store.save(value); broadcast(config); return config }))
  handle('translation:run', (event, value) => outcome(async () => {
    // 原生窗口可见性作为最后一道门控，后台卡片不能自动发送旧原文。
    if (event.sender.id !== cardWindow?.webContents.id || !cardWindow.isVisible() || cardWindow.isMinimized()) throw new StoreError('CANCELED', '卡片已隐藏，翻译暂停。')
    const parsed = requestSchema.safeParse(value)
    if (!parsed.success) throw new StoreError('VALIDATION', '请输入有效的翻译文本（最多 20,000 个字符）。')
    return runRequest(event, parsed.data.requestId, async signal => translateText(await store.getEngine(parsed.data.engineId), parsed.data, signal))
  }))
  handle('translation:cancel', (event, value) => {
    if (typeof value === 'string') requests.get(`${event.sender.id}:${value}`)?.controller.abort()
  })
  handle('engine:test', (event, value) => outcome(() => runRequest(event, `test-${crypto.randomUUID()}`, async signal => {
    const engine = await store.resolveEngine(value)
    return translateText(engine, { requestId: 'connection-test', engineId: engine.id, text: 'Hello, world!', source: 'en', mode: 'standard' }, signal)
  })))
  handle('window:show-card', () => showCard())
  handle('window:settings', () => showSettings())
  handle('window:hide-card', event => { if (event.sender.id === cardWindow?.webContents.id) cardWindow.hide() })
  handle('window:is-visible', event => event.sender.id === cardWindow?.webContents.id && cardWindow.isVisible() && !cardWindow.isMinimized())
  handle('window:pin', (_event, value) => outcome(async () => {
    if (typeof value !== 'boolean') throw new StoreError('VALIDATION', '置顶参数无效。')
    const config = await store.setAlwaysOnTop(value); broadcast(config); return config
  }))
  handle('window:compact', (_event, value) => outcome(async () => {
    if (typeof value !== 'boolean') throw new StoreError('VALIDATION', '卡片模式参数无效。')
    const config = await store.setCompactMode(value); broadcast(config); return config
  }))
  handle('clipboard:write', (_event, value) => {
    if (typeof value !== 'string' || value.length > 100000) throw new StoreError('VALIDATION', '复制内容无效。')
    return clipboard.writeText(value)
  })
  handle('app:quit', () => { app.quit() })
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (store) { if (store.getPublicConfig().setupCompleted) showCard(); else showSettings() } })
  app.whenReady().then(async () => {
    store = new ConfigStore(join(app.getPath('userData'), 'config.json'), {
      encrypt: async value => {
        if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('系统加密不可用')
        return (await safeStorage.encryptStringAsync(value)).toString('base64')
      },
      decrypt: async value => (await safeStorage.decryptStringAsync(Buffer.from(value, 'base64'))).result,
    })
    try { await store.load() } catch (error) {
      dialog.showErrorBox('translation-space · 无法读取配置', error instanceof Error ? error.message : '请检查配置文件。')
      app.quit(); return
    }
    registerIPC()
    const image = nativeImage.createFromPath(join(app.getAppPath(), process.platform === 'darwin' ? 'assets/trayTemplate.png' : 'assets/icon.png')).resize({ width: 20, height: 20 })
    if (process.platform === 'darwin') image.setTemplateImage(true)
    tray = new Tray(image)
    tray.setToolTip('translation-space · 中英互译')
    tray.on('click', showCard)
    updateTray()
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ label: 'translation-space', submenu: [{ label: '设置', click: showSettings }, { type: 'separator' as const }, { role: 'quit' as const, label: '退出 translation-space' }] }] : []),
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ label: '打开翻译卡片', click: showCard }, { label: '设置', click: showSettings }] },
    ]))
    const config = store.getPublicConfig()
    if (!config.setupCompleted) showSettings()
    else if (config.preferences.showCardOnStartup) showCard()
    app.on('activate', () => { if (store.getPublicConfig().setupCompleted) showCard(); else showSettings() })
    screen.on('display-removed', () => { if (cardWindow) cardWindow.setBounds(visibleBounds(cardWindow.getBounds(), cardCompact)) })
  }).catch(() => { dialog.showErrorBox('translation-space · 启动失败', '无法初始化桌面窗口，请重新启动。'); app.quit() })
}

app.on('before-quit', () => { quitting = true; clearTimeout(boundsTimer); for (const request of requests.values()) request.controller.abort() })
app.on('window-all-closed', () => { /* 关闭窗口后继续由菜单栏／托盘提供入口。 */ })
