/* =============================================================================
 * check-i18n.mjs —— 中英文词条 key 一一对应校验（防跑偏护栏）
 *
 * 标准（见 AGENT.md「i18n 硬性规范」）：
 *   所有用户可见文案 100% 走 t('key')；zh-CN.ts 与 en-US.ts 的 key 必须一一对应。
 *
 * 用法：npm run check:i18n
 *   通过 → exit 0；任一语言缺失 key → 打印缺失清单并 exit 1（CI / 本地校验可用）。
 * ========================================================================== */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 词条文件是扁平的 'key': 'value' 字典，用正则提取 key 集合 */
function extractKeys(file) {
  const src = readFileSync(join(root, 'src/i18n/locales', file), 'utf8')
  const re = /['"]([^'"\n]+)['"]\s*:/g
  return new Set([...src.matchAll(re)].map((m) => m[1]))
}

const zh = extractKeys('zh-CN.ts')
const en = extractKeys('en-US.ts')

const onlyZh = [...zh].filter((k) => !en.has(k)).sort()
const onlyEn = [...en].filter((k) => !zh.has(k)).sort()

if (onlyZh.length || onlyEn.length) {
  console.error('[check-i18n] FAILED: zh-CN 与 en-US 词条 key 不一一对应')
  if (onlyZh.length) console.error('  仅存在于 zh-CN（en-US 缺失）:', onlyZh.join(', '))
  if (onlyEn.length) console.error('  仅存在于 en-US（zh-CN 缺失）:', onlyEn.join(', '))
  process.exit(1)
}

console.log(`[check-i18n] OK: zh-CN 与 en-US 各 ${zh.size} 个 key，一一对应`)
