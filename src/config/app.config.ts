/* =============================================================================
 * app.config.ts —— 软件「身份与界面」对接文件（完整版唯一要改的地方之一）
 *
 * ── 完整版开发只需做三件事 ──────────────────────────────────────────────
 *   1. 改本文件：标题 / LOGO / 软件名 / 版本号 / 关于 / 帮助 / 状态栏 / 支付定价
 *   2. 改 src/config/app.commands.ts：注册业务命令 + 追加菜单
 *   3. 客户区：在 src/App.vue 的 <BaseWindow> 默认插槽放业务组件或 <RouterView />
 *
 *   框架核心（src/layouts/BaseWindow.vue、src/payment/*、src-tauri/*）永不修改。
 * ========================================================================== */
import type {
  BrandConfig,
  AboutConfig,
  MenuDef,
  MenuItem,
  ReleaseNote,
} from '../layouts/BaseWindow.vue'
import type { VmqConfig } from '../payment/vmq'
import { STORE_WEB_URL } from './store.config'

/**
 * 固定联系方式 —— 帮助菜单「联系邮箱」项与「关于」弹窗信息行共用。
 * 换软件只改这一行，两处同时生效。
 */
export const CONTACT_EMAIL = 'sangkl@163.com'

export interface AppConfig {
  /** 品牌：标题栏居中标题 + 状态栏默认文案 + LOGO + 软件名 + 版本号 */
  brand: BrandConfig
  /** 关于弹窗：描述 / 版权 / 信息行；要改布局用 BaseWindow 的 #about 插槽 */
  about: AboutConfig
  /** 帮助菜单项；完整版换成「使用文档 / 检查更新 / 反馈」等 */
  helpItems: MenuItem[]
  /** 顶部菜单栏；不传则用框架内置通用配置（文件/编辑/视图/设置/帮助） */
  menus?: MenuDef[]
  /** 客户区右键菜单；不传则用框架内置 */
  contextMenu?: MenuItem[]
  /** 版本清单 */
  releases?: ReleaseNote[]
  /** 状态栏跑马灯文本：string 单条，string[] 多条轮播 */
  statusText: string | string[]
  /** 初始主题 */
  defaultTheme: 'light' | 'dark'
  /** 初始是否显示底部状态栏 */
  statusBarVisible: boolean
  /** 状态栏右侧固定信息（如版本号） */
  statusRight?: string
  /** 支付配置 */
  pay: {
    /** 收银台标题 = `${appName}收银台` */
    appName: string
    /** 实际支付金额（元）。完整版按定价改这里 */
    price: number | string
    /** 商品 ID 模式（服务端校验价格，更安全）；传了则忽略 price */
    productId?: string
    /** 倒计时秒数，默认 5 分钟 */
    expiresIn: number
    /** 轮询间隔，默认 3 秒 */
    pollInterval: number
    /** V免签 凭据；不传用框架默认 appId/appSecret */
    config?: Partial<VmqConfig>
  }
}

/**
 * 半成品默认配置（外观 = code.html 蓝色方块图标 + 浅色主题）。
 * 完整版直接覆盖下面各项即可，框架与界面结构都不用动。
 *
 * 示例（完整版）：
 *   brand: { title: '我的工具箱', logo: '/logo.svg', icon: 'fa-solid fa-toolbox', appName: '我的工具箱', version: 'v1.0.0' }
 *   about: { description: '一站式工具集合', copyright: '© 2026 Acme', meta: [{ label: '官网:', value: 'https://...' }] }
 *   pay:   { appName: '我的工具箱', price: 16 }
 */
export const appConfig: AppConfig = {
  brand: {
    title: '照片模糊修复高清',
    logo: '/logo.png',
    icon: 'fa-solid fa-wand-magic-sparkles',
    appName: '照片模糊修复高清',
    version: 'v1.0.3',
  },
  about: {
    description: 'about.desc',
    copyright: '',
    meta: [
      { label: 'about.meta.design', value: 'Win11 Fluent & Light Clean' },
      { label: 'about.meta.source', value: '照片模糊修复高清（内置增强引擎）' },
      { label: 'about.meta.stack', value: 'Vue 3 / Tauri 2 / Rust' },
      { label: 'about.meta.config', value: 'src/config/app.config.ts' },
      { label: 'about.meta.contact', value: CONTACT_EMAIL },
      { label: 'about.meta.store', value: STORE_WEB_URL },
    ],
  },
  helpItems: [
    { id: 'shell.about', labelKey: 'cmd.shell.about', icon: 'fa-solid fa-circle-info' },
    { id: 'shell.version', labelKey: 'cmd.shell.version', icon: 'fa-solid fa-code-branch' },
    { id: 'help.sep1', separator: true },
    // 固定联系方式：点击即把邮箱复制到剪贴板（命令实现见 app.commands.ts 的 'help.contact'）
    { id: 'help.contact', labelKey: 'cmd.help.contact', labelParams: { email: CONTACT_EMAIL }, icon: 'fa-regular fa-envelope' },
  ],
  menus: undefined,
  contextMenu: undefined,
  releases: [
    { version: 'v1.0.3', desc: 'release.v103', current: true },
    { version: 'v1.0.2', desc: 'release.v102' },
    { version: 'v1.0.1', desc: 'release.v101' },
  ],
  statusText: 'AI 智能增强 · 人像超清修复 · 通用去模糊',
  defaultTheme: 'light',
  statusBarVisible: true,
  statusRight: 'v1.0.3',
  pay: {
    appName: '照片模糊修复高清',
    price: 39.9,
    productId: '',
    expiresIn: 300,
    pollInterval: 3000,
    config: undefined, // 凭据已按 TASK.md 第 3 项写入 Rust 侧 vmq_config()；此处无需再传
  },
}

export default appConfig
