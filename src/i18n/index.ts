/* =============================================================================
 * i18n —— 轻量国际化（零第三方依赖，只依赖 vue 的 ref）
 *
 * 用法：
 *   import { t, locale, setLocale } from '../i18n'
 *   t('menu.file')                    → 「文件」/「File」
 *   t('about.title', { name: 'X' })   → 「关于 X」/「About X」
 *
 * 业务自定义文案：setLocaleMessages('en-US', { 'biz.title': 'My Tool' })
 * 业务词条优先级高于框架词条，可覆盖内置文案。
 * ========================================================================== */
import { ref } from 'vue'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'

export const SUPPORTED_LOCALES = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en-US', label: 'English' },
] as const

export type Locale = (typeof SUPPORTED_LOCALES)[number]['code']
export const DEFAULT_LOCALE: Locale = 'zh-CN'

const builtin: Record<Locale, Record<string, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
}
/** 业务注入的词条（覆盖同名内置 key） */
const custom: Record<Locale, Record<string, string>> = {
  'zh-CN': {},
  'en-US': {},
}

const STORAGE_KEY = 'basewindow:locale'

function isLocale(v: unknown): v is Locale {
  return v === 'zh-CN' || v === 'en-US'
}

/** 首次运行跟随系统语言；之后以用户选择为准 */
function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (isLocale(saved)) return saved
  } catch {
    /* 隐私模式 / 存储不可用：静默降级到系统语言 */
  }
  const langs = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : []
  const hit = langs.find((l) => typeof l === 'string' && l.toLowerCase().startsWith('zh'))
  return hit ? 'zh-CN' : 'en-US'
}

export const locale = ref<Locale>(detectLocale())

export function setLocale(next: Locale): void {
  locale.value = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* 存不进去也不影响本次会话 */
  }
  document.documentElement.lang = next
}

/** 业务注入/覆盖词条 */
export function setLocaleMessages(target: Locale, dict: Record<string, string>): void {
  Object.assign(custom[target], dict)
}

/**
 * 取文案：当前语言 → 默认语言 → key 本身（缺失时直接暴露 key，便于排查）。
 * 支持 {name} 形式的占位符替换。
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const cur = { ...builtin[locale.value], ...custom[locale.value] }
  let text = cur[key] ?? builtin[DEFAULT_LOCALE][key] ?? custom[DEFAULT_LOCALE][key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.split(`{${k}}`).join(String(v))
    }
  }
  return text
}

if (typeof document !== 'undefined') document.documentElement.lang = locale.value

export default { t, locale, setLocale, setLocaleMessages, SUPPORTED_LOCALES, DEFAULT_LOCALE }
