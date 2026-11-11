import { _electron as electron, type ElectronApplication } from 'playwright'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import type { DesktopBridge } from '../shared/types'

/** 用独立用户目录和本机模拟服务验证真实 Electron 链路，不调用用户的付费引擎。 */
async function main() {
  const requests: string[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1')
    if (url.pathname === '/get') {
      const text = url.searchParams.get('q') ?? ''
      requests.push(text)
      const send = () => { if (!response.destroyed) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ responseStatus: 200, responseData: { translatedText: text === 'Hello, world!' ? '你好，世界！' : `译文：${text}` } })) } }
      if (text === 'quota test') { response.statusCode = 429; response.end(); return }
      setTimeout(send, text.startsWith('slow') ? 1500 : 20)
      return
    }
    if (url.pathname === '/v1/chat/completions') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: ['你好，世界！', '世界，你好！'], explanation: '这两种译法采用不同的语序。' }) } }] }))
      return
    }
    response.statusCode = 404; response.end()
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  assert(address && typeof address === 'object')
  const endpoint = `http://127.0.0.1:${address.port}`
  const userData = await mkdtemp(join(tmpdir(), 'translation-space-e2e-'))
  const output = resolve('.test-artifacts')
  await mkdir(output, { recursive: true })
  let desktop: ElectronApplication | undefined
  const errors: string[] = []
  let clipboardBackedUp = false
  const env: Record<string, string> = { ...process.env as Record<string, string>, BETWEEN_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    desktop = await electron.launch({ args: ['.'], env, timeout: 30000 })
    await desktop.evaluate(async ({ clipboard, ClipboardItem }) => {
      const items = await clipboard.read()
      // 备份只留在 Electron 主进程内存中，不传出用户剪贴板内容。
      const backup = await Promise.all(items.map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))))
      ;(globalThis as typeof globalThis & { betweenClipboardBackup: Electron.ClipboardItem[] }).betweenClipboardBackup = backup
    })
    clipboardBackedUp = true
    const settings = await desktop.firstWindow()
    settings.on('pageerror', error => errors.push(error.message))
    await settings.getByRole('button', { name: '保存并打开卡片' }).waitFor()
    await settings.screenshot({ path: join(output, 'settings.png') })
    const initial = await settings.evaluate(async () => (window as Window & { desktop: DesktopBridge }).desktop.getConfig())
    assert(initial.ok && initial.data.setupCompleted === false)
    const configured = await settings.evaluate(async ({ endpoint }) => {
      const bridge = (window as Window & { desktop: DesktopBridge }).desktop
      const current = await bridge.getConfig()
      if (!current.ok) throw new Error(current.error.message)
      current.data.engines[0].endpoint = `${endpoint}/get`
      return bridge.saveConfig(current.data)
    }, { endpoint })
    assert(configured.ok)
    // 等待广播更新首启草稿，再通过可见按钮完成配置。
    await settings.waitForTimeout(100)
    const cardPromise = desktop.waitForEvent('window')
    await settings.getByRole('button', { name: '保存并打开卡片' }).click()
    const card = await cardPromise
    card.on('pageerror', error => errors.push(error.message))
    const input = card.getByRole('textbox', { name: '待翻译文本' })
    await input.waitFor()
    await input.fill('Hello, world!')
    await card.getByText('你好，世界！', { exact: true }).waitFor()
    await card.waitForTimeout(900)
    assert.equal(requests.filter(text => text === 'Hello, world!').length, 1)
    await card.getByRole('button', { name: '复制译文', exact: true }).click()
    assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), '你好，世界！')
    await card.screenshot({ path: join(output, 'card.png') })

    // 切换真实原生窗口尺寸，保留同一组件的原文和结果。
    await card.getByRole('button', { name: '切换迷你卡片', exact: true }).click()
    await card.getByRole('button', { name: '展开标准卡片', exact: true }).waitFor()
    const miniBounds = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'translation-space · 翻译')!.getBounds())
    assert.equal(miniBounds.width, 300)
    assert.equal(miniBounds.height, 150)
    assert.equal(await input.inputValue(), 'Hello, world!')
    await card.getByText('你好，世界！', { exact: true }).waitFor()
    await card.screenshot({ path: join(output, 'compact-card.png') })
    await input.fill('mini translation')
    await card.getByText('译文：mini translation', { exact: true }).waitFor()
    await card.getByRole('button', { name: '复制译文', exact: true }).click()
    assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), '译文：mini translation')
    await card.getByRole('button', { name: '展开标准卡片', exact: true }).click()
    await card.getByRole('button', { name: '切换迷你卡片', exact: true }).waitFor()
    const normalBounds = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'translation-space · 翻译')!.getBounds())
    assert.equal(normalBounds.width, 440)
    assert.equal(normalBounds.height, 680)
    assert.equal(await input.inputValue(), 'mini translation')
    await card.getByText('译文：mini translation', { exact: true }).waitFor()

    // 快速连续输入只翻译最后的文本，手动立即翻译不会与定时器重复。
    await input.fill('first draft')
    await card.waitForTimeout(200)
    await input.fill('final draft')
    await card.waitForTimeout(300)
    assert.equal(requests.includes('final draft'), false)
    await card.getByText('译文：final draft', { exact: true }).waitFor()
    assert.equal(requests.includes('first draft'), false)
    await input.fill('manual once')
    await card.getByRole('button', { name: '翻译', exact: true }).click()
    await card.getByText('译文：manual once', { exact: true }).waitFor()
    await card.waitForTimeout(900)
    assert.equal(requests.filter(text => text === 'manual once').length, 1)

    // 模拟中文输入法：组词超过防抖时长也不发请求，确认后自动翻译。
    await input.dispatchEvent('compositionstart')
    await input.fill('中文输入测试')
    await card.waitForTimeout(900)
    assert.equal(requests.includes('中文输入测试'), false)
    await input.dispatchEvent('compositionend', { data: '中文输入测试' })
    await card.getByText('译文：中文输入测试', { exact: true }).waitFor()
    const sameImeCount = requests.filter(text => text === '中文输入测试').length
    await input.dispatchEvent('compositionstart')
    await card.waitForTimeout(900)
    assert.equal(requests.filter(text => text === '中文输入测试').length, sameImeCount)
    await input.dispatchEvent('compositionend', { data: '中文输入测试' })
    await card.getByText('译文：中文输入测试', { exact: true }).waitFor()
    assert.equal(requests.filter(text => text === '中文输入测试').length, sameImeCount + 1)

    // 取消自动请求后，相同文本不能自动立即重启。
    await input.fill('slow canceled')
    await card.getByRole('button', { name: '取消', exact: true }).waitFor()
    await card.getByRole('button', { name: '取消', exact: true }).click()
    await card.waitForTimeout(1800)
    assert.equal(requests.filter(text => text === 'slow canceled').length, 1)
    assert.equal(await card.getByText('译文：slow canceled', { exact: true }).count(), 0)

    // 请求尚未完成时修改原文，迟到响应不能重新出现在结果区。
    await input.fill('slow request')
    await card.getByRole('button', { name: '取消', exact: true }).waitFor()
    await input.fill('new request')
    await card.getByText('译文：new request', { exact: true }).waitFor()
    await card.waitForTimeout(1600)
    assert.equal(await card.getByText('译文：slow request', { exact: true }).count(), 0)

    await input.fill('quota test')
    await card.getByText('这次翻译没有完成', { exact: true }).waitFor()
    await card.waitForTimeout(900)
    assert.equal(requests.filter(text => text === 'quota test').length, 1)
    await input.fill('')
    const emptyCount = requests.length
    await card.waitForTimeout(900)
    assert.equal(requests.length, emptyCount)

    // 隐藏后切换默认引擎，不应自动向新服务发送卡片中的旧原文。
    await input.fill('visibility guard')
    await card.getByText('译文：visibility guard', { exact: true }).waitFor()
    const visibilityCount = requests.length
    const priorConfig = await settings.evaluate(() => window.desktop!.getConfig())
    assert(priorConfig.ok)
    await card.getByRole('button', { name: '隐藏卡片', exact: true }).click()
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'translation-space · 翻译')!.isVisible()), false)
    await settings.evaluate(async ({ config, endpoint }) => {
      config.engines.push({ id: 'visibility-engine', name: '隐藏时切换的服务', provider: 'mymemory', endpoint: `${endpoint}/get` })
      config.defaultEngineId = 'visibility-engine'
      const saved = await window.desktop!.saveConfig(config)
      if (!saved.ok) throw new Error(saved.error.message)
    }, { config: structuredClone(priorConfig.data), endpoint })
    await settings.waitForTimeout(1000)
    assert.equal(requests.length, visibilityCount)
    await settings.evaluate(() => window.desktop!.showCard())
    await card.getByText('译文：visibility guard', { exact: true }).waitFor()
    assert.equal(requests.length, visibilityCount + 1)
    await input.fill('')
    await settings.evaluate(config => window.desktop!.saveConfig(config), priorConfig.data)

    const before = await card.evaluate(async () => (window as Window & { desktop: DesktopBridge }).desktop.getConfig())
    assert(before.ok)
    await card.getByRole('button', { name: '取消置顶', exact: true }).click()
    await card.getByRole('button', { name: '置顶卡片', exact: true }).waitFor()
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'translation-space · 翻译')?.isAlwaysOnTop()), false)

    // AI 连接测试走真实 IPC 与本机 HTTP；不落盘测试密钥、不触发系统钥匙串。
    const ai = await settings.evaluate(async ({ endpoint }) => (window as Window & { desktop: DesktopBridge }).desktop.testEngine({ id: 'e2e-ai', name: '测试 AI', provider: 'openai', endpoint: `${endpoint}/v1`, apiKey: 'temporary-fixture-key', model: 'fixture-model' }), { endpoint })
    assert(ai.ok)
    assert.equal(ai.data.translations.length, 2)
    const invalid = await settings.evaluate(async () => (window as Window & { desktop: DesktopBridge }).desktop.saveConfig({ invalid: true } as never))
    assert(!invalid.ok)

    // 用户通过配置表单添加、测试、修改、设为默认和删除引擎。
    await settings.getByRole('button', { name: '添加引擎', exact: true }).click()
    const editor = settings.getByRole('dialog')
    await editor.getByLabel('引擎类型').selectOption('mymemory')
    await editor.getByLabel('显示名称').fill('自测公共引擎')
    await editor.getByLabel('服务端点 URL').fill(`${endpoint}/get`)
    await editor.getByRole('button', { name: '测试连接', exact: true }).click()
    await editor.getByText(/连接成功/).waitFor()
    await editor.getByRole('button', { name: '添加到引擎列表' }).click()
    await settings.getByRole('button', { name: '编辑自测公共引擎', exact: true }).click()
    await settings.getByRole('dialog').getByLabel('显示名称').fill('自测引擎修改')
    await settings.getByRole('button', { name: '确认修改' }).click()
    await settings.getByRole('button', { name: '将自测引擎修改设为默认引擎', exact: true }).click()
    await settings.getByRole('button', { name: '保存设置', exact: true }).click()
    await card.waitForFunction(() => document.querySelector<HTMLSelectElement>('[aria-label="当前翻译引擎"]')?.selectedOptions[0]?.text === '自测引擎修改')
    await settings.getByRole('button', { name: '删除自测引擎修改', exact: true }).click()
    await settings.getByRole('button', { name: '移除引擎', exact: true }).click()
    await settings.getByRole('button', { name: '保存设置', exact: true }).click()
    await card.waitForFunction(() => document.querySelector<HTMLSelectElement>('[aria-label="当前翻译引擎"]')?.selectedOptions[0]?.text === 'MyMemory 公共翻译')

    // 设置页保存偏好后另一个窗口即时生效。
    await settings.getByRole('button', { name: /悬浮卡片/ }).click()
    await settings.getByRole('slider', { name: '背景不透明度' }).fill('75')
    await settings.getByRole('button', { name: '保存设置', exact: true }).click()
    await card.waitForFunction(() => document.querySelector<HTMLElement>('.translation-window')?.style.getPropertyValue('--card-opacity') === '0.75')
    await settings.screenshot({ path: join(output, 'appearance.png') })
    await settings.getByRole('switch', { name: '输入后自动翻译', exact: true }).click()
    await settings.getByRole('button', { name: '保存设置', exact: true }).click()
    await card.waitForFunction(() => !document.body.textContent?.includes('输入后自动翻译'))
    await input.fill('only manual')
    await card.waitForTimeout(900)
    assert.equal(requests.includes('only manual'), false)
    await card.getByRole('button', { name: '翻译', exact: true }).click()
    await card.getByText('译文：only manual', { exact: true }).waitFor()
    await card.setViewportSize({ width: 360, height: 480 })
    assert.equal(await card.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await card.getByRole('button', { name: '隐藏卡片', exact: true }).click()
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'translation-space · 翻译')?.isVisible()), false)
    await settings.evaluate(async () => (window as Window & { desktop: DesktopBridge }).desktop.showCard())
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'translation-space · 翻译')?.isVisible()), true)
    const stored = await readFile(join(userData, 'config.json'), 'utf8')
    assert(!stored.includes('new request') && !stored.includes('temporary-fixture-key'))
    assert.deepEqual(errors, [])
    console.log(`桌面自测通过：首启、自动防抖、手动去重、IME、取消与旧响应、失败不循环、迷你300×150及展开保留内容、复制、置顶、AI连接、引擎管理、跨窗同步、关闭自动翻译、隐藏恢复。模拟请求 ${requests.length} 次。截图：${output}`)
  } finally {
    if (desktop && clipboardBackedUp) await desktop.evaluate(async ({ clipboard }) => {
      const state = globalThis as typeof globalThis & { betweenClipboardBackup?: Electron.ClipboardItem[] }
      if (state.betweenClipboardBackup?.length) await clipboard.write(state.betweenClipboardBackup)
      else clipboard.clear()
      delete state.betweenClipboardBackup
    }).catch(() => undefined)
    await desktop?.close()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
