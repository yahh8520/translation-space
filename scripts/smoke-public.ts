import { translateText } from '../core/translation'
import { DEFAULT_CONFIG } from '../shared/types'

/** 单独执行真实公共服务冒烟，不混入离线回归，也不代表译质人工验收。 */
async function main() {
  const samples = [
    'Hello, world!',
    '这是一款简洁的翻译工具。',
    'A quiet place for words. '.repeat(24) + '\nKeep the next paragraph.',
  ]
  for (const [index, text] of samples.entries()) {
    const start = Date.now()
    const result = await translateText(DEFAULT_CONFIG.engines[0], { requestId: `public-${index}`, engineId: 'public-mymemory', text, source: 'auto', mode: 'standard' })
    if (!result.translations[0]?.trim()) throw new Error('服务返回空译文')
    if (text.includes('\n') && !result.translations[0].includes('\n')) throw new Error('译文丢失段落')
    console.log(JSON.stringify({ sample: index + 1, elapsedMs: Date.now() - start, source: result.source, target: result.target, translation: result.translations[0] }))
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : '公共服务测试失败'); process.exitCode = 1 })
