/* =============================================================================
 * app.commands.ts —— 软件「命令与菜单」对接文件（完整版加功能就改这里）
 *
 * ── 完整版开发只需做三件事 ──────────────────────────────────────────────
 *   1. 改 src/config/app.config.ts：软件身份 / 界面 / 支付定价
 *   2. 改本文件：在 setupCommands 里注册业务命令；需要新菜单就加到 extraMenus
 *   3. 客户区：业务组件放 src/App.vue 的 <BaseWindow> 默认插槽
 *
 * 命令 id 命名约定：'file.*' / 'edit.*' / 'view.*' / 'app.*' …（避开框架保留的
 * 'win.*' / 'shell.*'，那两类框架永远优先执行，业务改不动）。框架不认识的命令
 * 才会走到 setupCommands 注册的处理器，或最终冒泡到 @command。
 * ========================================================================== */
import type { MenuDef } from '../layouts/BaseWindow.vue'
import type BaseWindow from '../layouts/BaseWindow.vue'
import { t } from '../i18n'
import { appConfig, CONTACT_EMAIL } from './app.config'

/**
 * 复制文本到剪贴板。
 * 优先 navigator.clipboard；Tauri 的 WebView2 下它可能不可用（非安全上下文 /
 * 无权限），故回退到 textarea + execCommand('copy')，复制失败也绝不抛错。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 继续走回退方案 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** 命令处理器可拿到的上下文：窗口实例 + 打开收银台 */
export interface CommandContext {
  /** BaseWindow 实例：可调 runCommand / setStatus / addMenu / openAbout 等 */
  win: InstanceType<typeof BaseWindow>
  /** 打开支付收银台（配置见 app.config.ts） */
  openPay: () => void
}

/**
 * 命令 id → 处理函数。完整版加功能 = 在这里加一行：
 *   'app.export': () => { /* 导出逻辑 *\/ }
 * 菜单项里把 id 写成 'app.export' 即自动连上。
 */
export function setupCommands(ctx: CommandContext): Record<string, (id: string) => void> {
  return {
    // 文件类
    'file.new': () => console.info('[功能] 新建文件（待实现）'),
    'file.open': () => console.info('[功能] 打开项目（待实现）'),
    'file.save': () => console.info('[功能] 保存配置（待实现）'),
    // 编辑类（先用浏览器原生剪贴板，完整版接业务选区）
    'edit.undo': () => document.execCommand('undo'),
    'edit.redo': () => document.execCommand('redo'),
    'edit.cut': () => document.execCommand('cut'),
    'edit.copy': () => document.execCommand('copy'),
    'edit.paste': () => document.execCommand('paste'),
    // 视图类
    'view.refresh': () => location.reload(),
    // 帮助类：固定联系方式 —— 点击把联系邮箱复制到剪贴板，并在状态栏给出反馈
    'help.contact': () => {
      copyText(CONTACT_EMAIL).then((ok) => {
        ctx.win.setStatus(
          ok ? t('license.copyOk', { email: CONTACT_EMAIL }) : t('license.copyFail', { email: CONTACT_EMAIL }),
        )
        // 6 秒后恢复配置里的默认跑马灯文案
        window.setTimeout(() => ctx.win.setStatus(appConfig.statusText), 6000)
      })
    },
    // 支付入口（菜单「解锁 B → 功能解锁」即触发）
    'pay.open': () => ctx.openPay(),
    // 照片修复模块：经 CustomEvent 桥接客户区组件（解耦命令与 UI）
    'repair.open': () => window.dispatchEvent(new CustomEvent('pr:open')),
    'repair.process': () => window.dispatchEvent(new CustomEvent('pr:process')),
    'repair.export': () => window.dispatchEvent(new CustomEvent('pr:export')),
  }
}

/**
 * 增量菜单：完整版按需追加，不必重写整份 menus。
 * 例：要加一个「工具(T)」菜单：
 *   { id: 'menu-tools', label: '工具', accel: 'T', items: [
 *     { id: 'app.calc', label: '计算器', shortcut: 'Ctrl+1' },
 *   ] }
 * id 重复时框架会告警并忽略，不会静默覆盖。
 */
export const extraMenus: MenuDef[] = [
  {
    id: 'menu-repair',
    labelKey: 'menu.repair',
    accel: 'R',
    items: [
      { id: 'repair.open', labelKey: 'cmd.repair.open', icon: 'fa-solid fa-folder-open', shortcut: 'Ctrl+O' },
      { id: 'repair.process', labelKey: 'cmd.repair.process', icon: 'fa-solid fa-wand-magic-sparkles' },
      { id: 'repair.export', labelKey: 'cmd.repair.export', icon: 'fa-solid fa-download', shortcut: 'Ctrl+S' },
    ],
  },
  {
    id: 'menu-unlock',
    labelKey: 'menu.unlock',
    accel: 'B',
    items: [
      { id: 'pay.open', labelKey: 'cmd.pay.open', icon: 'fa-solid fa-lock-open', shortcut: 'Ctrl+U' },
    ],
  },
]
