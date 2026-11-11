import { _electron as electron } from 'playwright'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import type { DesktopBridge } from '../shared/types'

/** 对打包后的应用做启动检查，不写入用户偏好或调用任何翻译服务。 */
async function main() {
  const executablePath = process.argv[2] ?? resolve('release/mac-arm64/translation-space.app/Contents/MacOS/translation-space')
  const userData = await mkdtemp(join(tmpdir(), 'between-package-'))
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const desktop = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`], env })
  try {
    const page = await desktop.firstWindow()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.getByRole('button', { name: '保存并打开卡片' }).waitFor()
    const packaged = await desktop.evaluate(({ app }) => app.isPackaged)
    assert(packaged)
    const actualPath = await desktop.evaluate(({ app }) => app.getPath('userData'))
    assert.equal(await realpath(actualPath), await realpath(userData))
    const result = await page.evaluate(() => (window as Window & { desktop: DesktopBridge }).desktop.getConfig())
    assert(result.ok)
    assert.equal(result.data.defaultEngineId, 'public-mymemory')
    assert.deepEqual(errors, [])
    console.log('打包应用启动检查通过：ASAR 资源、预加载桥、首启配置页、独立用户目录。未执行安装或第三方翻译调用。')
  } finally { await desktop.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
