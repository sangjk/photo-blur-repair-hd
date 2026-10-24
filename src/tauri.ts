/* =============================================================================
 * tauri.ts —— Tauri 运行时桥接层（轻量封装，零额外依赖）
 *
 * 设计要点：
 *   - isTauri()      判断是否运行在 Tauri/WebView2 内（而非纯浏览器 / vite dev）
 *   - invokeSafe()   安全调用 Rust 指令：非 Tauri 环境或调用失败时返回 null，绝不抛错
 *   - 所有「会接触密钥 / 落盘」的能力都走 Rust 侧指令，前端只拿结果
 *
 * 凭据安全：V免签 appSecret 只存在于 Rust 侧（src-tauri/src/lib.rs），前端通过
 * vmqSign() 拿到签名结果，永远看不到密钥原文。
 * ========================================================================== */
import { invoke } from '@tauri-apps/api/core'

/** 是否运行在 Tauri 运行时（WebView2 内），而非纯浏览器 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 安全 invoke：非 Tauri 环境返回 null，调用失败也返回 null，不抛错 */
export async function invokeSafe<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null
  try {
    return await invoke<T>(cmd, args)
  } catch (e) {
    if (import.meta.env.DEV) console.warn(`[tauri] invoke(${cmd}) 失败:`, e)
    return null
  }
}

// ── V免签 凭据（appSecret 仅在 Rust 侧，前端永远拿不到）────────────────────
export interface VmqPublicConfig {
  apiHost: string
  appId: string
}
/** 获取对外公开配置（不含 appSecret） */
export function vmqPublicConfig(): Promise<VmqPublicConfig | null> {
  return invokeSafe<VmqPublicConfig>('vmq_public_config')
}
/**
 * 由 Rust 侧用 appSecret 计算签名，前端不接触密钥。
 * kind: create => params = [payId, param, type, amount]
 *       check / close => params = [orderId]
 */
export function vmqSign(kind: 'create' | 'check' | 'close', params: string[]): Promise<string | null> {
  return invokeSafe<string>('vmq_sign', { kind, params })
}

/**
 * 由 Rust 侧（reqwest）转发 V免签 API 请求，绕开 WebView/浏览器 CORS 限制。
 * 返回原始 HTTP status 与响应体文本，由 vmq.ts 负责解析 JSON 与业务 code 判定。
 */
export interface VmqProxyResp {
  status: number
  body: string
}
export function vmqProxy(args: {
  path: string
  method?: string
  headers?: Record<string, string>
  body?: string | null
}): Promise<VmqProxyResp> {
  return invoke<VmqProxyResp>('vmq_proxy', args)
}

// ── 授权凭证（支付成功后落盘，重启不丢）──────────────────────────────────
export interface LicenseRecord {
  orderId: string
  machine: string
  signature: string
  createdAt: number
}
/** 传入服务端订单号即可，机器绑定 + 签名由 Rust 侧完成（防篡改 / 防止拷贝到其他机器） */
export function licenseSave(orderId: string) {
  return invokeSafe('license_save', { orderId })
}
export function licenseLoad(): Promise<LicenseRecord | null> {
  return invokeSafe<LicenseRecord>('license_load')
}
export function licenseClear() {
  return invokeSafe('license_clear')
}

// ── 窗口状态记忆（位置 / 尺寸 / 最大化）────────────────────────────────────
export interface WindowState {
  x: number
  y: number
  w: number
  h: number
  maximized: boolean
}
export function windowSaveState(s: WindowState) {
  return invokeSafe('window_save_state', {
    x: s.x,
    y: s.y,
    w: s.w,
    h: s.h,
    maximized: s.maximized,
  })
}
export function windowLoadState(): Promise<WindowState | null> {
  return invokeSafe<WindowState>('window_load_state')
}

// ── 应用设置（关闭行为：最小化到托盘 / 直接退出）──────────────────────────
export interface AppSettings {
  closeBehavior: 'tray' | 'quit'
}
export function settingsSave(s: AppSettings) {
  return invokeSafe('settings_save', { closeBehavior: s.closeBehavior })
}
export function settingsLoad(): Promise<AppSettings | null> {
  return invokeSafe<AppSettings>('settings_load')
}

// ── 语言同步（托盘菜单跟随界面语言，i18n 全覆盖、无硬编码文案）────────────
export function setAppLocale(locale: string) {
  return invokeSafe('set_app_locale', { locale })
}

// ── 启动白屏优化：首帧渲染完成后通知 Rust 显示窗口（窗口 visible:false 启动）──
export function appReady() {
  return invokeSafe('app_ready')
}

// ── 导出落盘：由 Rust 侧写入用户指定路径（保证桌面端一定能存下来，且可选位置）──
/** 保存 UTF-8 文本文件（CSV / JSON 备份 / GEDCOM），返回保存后的绝对路径 */
export function saveTextFile(fileName: string, content: string): Promise<string | null> {
  return invokeSafe<string>('save_text_file', { fileName, content })
}

/** 保存二进制文件（base64 传入）到「下载」目录，返回保存后的绝对路径（保留以兼容旧调用） */
export function saveBinaryFile(fileName: string, base64: string): Promise<string | null> {
  return invokeSafe<string>('save_binary_file', { fileName, base64 })
}

/** 系统保存对话框：返回用户选择的完整路径（含文件名），取消则返回 null */
export interface DialogFilter {
  name: string
  extensions: string[]
}
export async function saveDialog(defaultName: string, filters?: DialogFilter[]): Promise<string | null> {
  if (!isTauri()) return null
  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    return await save({ defaultPath: defaultName, filters })
  } catch (e) {
    if (import.meta.env.DEV) console.warn('[tauri] saveDialog 失败:', e)
    return null
  }
}

/** 保存到用户指定的完整路径（由 saveDialog 返回），返回保存后的绝对路径 */
export function saveBinaryFileTo(filePath: string, base64: string): Promise<string | null> {
  return invokeSafe<string>('save_binary_file_to', { filePath, base64 })
}
