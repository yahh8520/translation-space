import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, validateConfig, validateEngine, type SecretCipher } from '../core/config-store'
import { DEFAULT_CONFIG } from '../shared/types'

const cipher: SecretCipher = {
  encrypt: async value => Buffer.from(`protected:${value}`).toString('base64'),
  decrypt: async value => Buffer.from(value, 'base64').toString().replace(/^protected:/, ''),
}

async function fixture() {
  const filename = join(await mkdtemp(join(tmpdir(), 'between-config-')), 'config.json')
  const store = new ConfigStore(filename, cipher)
  await store.load()
  return { store, filename }
}

test('首次启动默认公共翻译，不持久化任何翻译内容', async () => {
  const { store, filename } = await fixture()
  assert.equal(store.getPublicConfig().setupCompleted, false)
  const config = { ...store.getPublicConfig(), setupCompleted: true, text: '不应保存的原文', translations: ['结果'] }
  await store.save(config)
  const saved = await readFile(filename, 'utf8')
  assert.equal(saved.includes('不应保存的原文'), false)
  assert.equal(saved.includes('translations'), false)
  const restored = new ConfigStore(filename, cipher)
  await restored.load()
  assert.equal(restored.getPublicConfig().setupCompleted, true)
})

test('密钥加密保存，界面只能读取保存状态，留空编辑不丢失密钥', async () => {
  const { store, filename } = await fixture()
  const config = store.getPublicConfig()
  config.engines.push({ id: 'ai-test', name: '测试 AI', provider: 'openai', endpoint: 'https://example.com/v1', model: 'test-model', apiKey: 'sensitive-test-key' })
  await store.save(config)
  assert.equal((await readFile(filename, 'utf8')).includes('sensitive-test-key'), false)
  const publicConfig = store.getPublicConfig()
  assert.equal(publicConfig.engines[1].apiKey, '')
  assert.equal(publicConfig.engines[1].hasApiKey, true)
  publicConfig.engines[1].name = '更新名称'
  await store.save(publicConfig)
  assert.equal((await store.getEngine('ai-test')).apiKey, 'sensitive-test-key')
})

test('切换服务商不继承密钥，删除后清理密钥', async () => {
  const { store, filename } = await fixture()
  const config = store.getPublicConfig()
  config.engines.push({ id: 'custom', name: '自定义', provider: 'google', endpoint: 'https://example.com', apiKey: 'old-secret' })
  await store.save(config)
  const modified = store.getPublicConfig()
  modified.engines[1].provider = 'libretranslate'
  await store.save(modified)
  assert.equal((await store.getEngine('custom')).apiKey, '')
  modified.engines.pop()
  await store.save(modified)
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')).secrets, {})
})

test('跨源修改端点时测试和保存都不继承旧密钥', async () => {
  for (const nextEndpoint of ['https://other.example/v1', 'https://trusted.example:8443/v1']) {
    const { store, filename } = await fixture()
    const config = store.getPublicConfig()
    config.engines.push({ id: 'ai-test', name: '测试 AI', provider: 'openai', endpoint: 'https://trusted.example/v1', model: 'test-model', apiKey: 'old-secret' })
    await store.save(config)
    const changed = store.getPublicConfig()
    changed.engines[1].endpoint = nextEndpoint
    assert.equal((await store.resolveEngine(changed.engines[1])).apiKey, '')
    const saved = await store.save(changed)
    assert.equal(saved.engines[1].hasApiKey, false)
    assert.equal((await store.getEngine('ai-test')).apiKey, '')
    assert.equal('ai-test' in JSON.parse(await readFile(filename, 'utf8')).secrets, false)
  }
})

test('同源路径调整允许测试和保存继续使用旧密钥', async () => {
  const { store } = await fixture()
  const config = store.getPublicConfig()
  config.engines.push({ id: 'ai-test', name: '测试 AI', provider: 'openai', endpoint: 'https://trusted.example/v1', model: 'test-model', apiKey: 'same-origin-secret' })
  await store.save(config)
  const changed = store.getPublicConfig()
  changed.engines[1].endpoint = 'https://trusted.example/proxy/v1'
  assert.equal((await store.resolveEngine(changed.engines[1])).apiKey, 'same-origin-secret')
  const saved = await store.save(changed)
  assert.equal(saved.engines[1].hasApiKey, true)
  assert.equal((await store.getEngine('ai-test')).apiKey, 'same-origin-secret')
})

test('跨源修改端点并显式填写新密钥时只使用新密钥', async () => {
  const { store } = await fixture()
  const config = store.getPublicConfig()
  config.engines.push({ id: 'ai-test', name: '测试 AI', provider: 'openai', endpoint: 'https://trusted.example/v1', model: 'test-model', apiKey: 'old-secret' })
  await store.save(config)
  const changed = store.getPublicConfig()
  changed.engines[1].endpoint = 'https://other.example/v1'
  changed.engines[1].apiKey = 'new-secret'
  assert.equal((await store.resolveEngine(changed.engines[1])).apiKey, 'new-secret')
  await store.save(changed)
  assert.equal((await store.getEngine('ai-test')).apiKey, 'new-secret')
})

test('系统加密失败时不写明文，也不覆盖原配置', async () => {
  const { filename, store } = await fixture()
  await store.save(store.getPublicConfig())
  const before = await readFile(filename, 'utf8')
  const failing = new ConfigStore(filename, { ...cipher, encrypt: async () => { throw new Error('unavailable') } })
  await failing.load()
  const config = failing.getPublicConfig()
  config.engines[0].apiKey = 'never-write-me'
  await assert.rejects(failing.save(config), /系统密钥保护/)
  assert.equal(await readFile(filename, 'utf8'), before)
})

test('损坏的配置保留原文件并明确报错', async () => {
  const { filename } = await fixture()
  await writeFile(filename, '{broken')
  const store = new ConfigStore(filename, cipher)
  await assert.rejects(store.load(), /原文件已保留/)
  assert.equal(await readFile(filename, 'utf8'), '{broken')
})

test('配置校验拒绝无默认引擎、重复 ID、任意查询参数及不安全远程 HTTP', () => {
  const missing = structuredClone(DEFAULT_CONFIG)
  missing.defaultEngineId = 'missing'
  assert.throws(() => validateConfig(missing))
  const duplicate = structuredClone(DEFAULT_CONFIG)
  duplicate.engines.push(duplicate.engines[0])
  assert.throws(() => validateConfig(duplicate))
  for (const endpoint of ['http://example.com', 'https://example.com?key=secret', 'https://user:pass@example.com', 'file:///tmp/service']) {
    assert.throws(() => validateEngine({ ...DEFAULT_CONFIG.engines[0], endpoint }))
  }
  assert.doesNotThrow(() => validateEngine({ ...DEFAULT_CONFIG.engines[0], endpoint: 'http://127.0.0.1:1234' }))
})

test('位置保存与窗口置顶并发更新不会丢失偏好', async () => {
  const { store } = await fixture()
  await Promise.all([
    store.setAlwaysOnTop(false),
    store.saveCardBounds({ x: -100, y: 10, width: 440, height: 680 }),
  ])
  assert.equal(store.getPublicConfig().preferences.alwaysOnTop, false)
  assert.equal(store.getCardBounds()?.x, -100)
})

test('旧版配置缺少新偏好时自动补齐，保留原引擎及加密密钥', async () => {
  const { store, filename } = await fixture()
  await store.save(store.getPublicConfig())
  const original = JSON.parse(await readFile(filename, 'utf8'))
  delete original.config.preferences.compactMode
  delete original.config.preferences.autoTranslate
  await writeFile(filename, JSON.stringify(original))
  const restored = new ConfigStore(filename, cipher)
  await restored.load()
  assert.equal(restored.getPublicConfig().preferences.compactMode, false)
  assert.equal(restored.getPublicConfig().preferences.autoTranslate, true)
  assert.equal(restored.getPublicConfig().engines[0].id, 'public-mymemory')
})

test('迷你与标准卡片分别记住尺寸，重启后保留模式', async () => {
  const { store, filename } = await fixture()
  const normal = { x: 10, y: 20, width: 480, height: 700 }
  const compact = { x: 40, y: 50, width: 300, height: 150 }
  await store.saveCardBounds(normal)
  await store.setCompactMode(true)
  await store.saveCardBounds(compact, true)
  const restored = new ConfigStore(filename, cipher)
  await restored.load()
  assert.equal(restored.getPublicConfig().preferences.compactMode, true)
  assert.deepEqual(restored.getCardBounds(false), normal)
  assert.deepEqual(restored.getCardBounds(true), compact)
  await restored.setCompactMode(false)
  assert.deepEqual(restored.getCardBounds(false), normal)
})
