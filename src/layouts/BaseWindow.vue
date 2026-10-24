<script lang="ts">
/* =============================================================================
 * BaseWindow.vue —— 通用桌面软件窗口外壳（半成品框架）
 * 技术栈：Vue 3 + TypeScript + Tailwind + Tauri 2（Rust 侧见 src-tauri/）
 * 设计稿：code.html（Win11 Fluent / Light Clean 浅色主题）
 *
 * ── 这个文件做什么 ──────────────────────────────────────────────────────────
 *   ✅ 窗口边框 / 非客户区 / 标题栏 / 标题 / 应用图标
 *   ✅ 窗口控制按钮（最小化 / 最大化还原 / 关闭）
 *   ✅ 菜单栏 / 菜单项 / 子菜单（无限层级 flyout）
 *   ✅ 右键上下文菜单（客户区内定位 + 边界溢出保护）
 *   ✅ 底部跑马灯状态栏、设置 / 关于 / 版本 三个弹窗
 *   ✅ 命令总线 command、快捷键自动绑定、Tauri 2 窗口控制（浏览器自动降级）
 *   ❌ 客户区（业务内容）—— 刻意不实现，只留一个 <slot />，后期按需填充
 *
 * ── 怎么用（每个新工具软件只做三件事）────────────────────────────────────────
 *   1. 复制本文件到新项目 src/layouts/BaseWindow.vue（零依赖，只依赖 vue + tailwind）
 *   2. 传 brand / about / statusText / helpItems 把「半成品内容」换成正式内容
 *   3. 在默认插槽里放业务组件或 <RouterView />，并监听 @command 处理业务命令
 *
 * ── 完整版替换点（不用改框架源码，改配置即可）────────────────────────────────
 *   标题       : brand.title（或 title prop）
 *   LOGO       : brand.logo 传图片 URL（png/svg）；不传则回退 brand.icon 的 Font Awesome 类
 *   帮助菜单   : helpItems（整份替换「帮助」下的菜单项）
 *   关于弹窗   : about（描述 + meta 行）；要完全自定义就用 #about 插槽
 *   设置弹窗   : #settings 插槽（默认内容是半成品占位开关）
 *   跑马灯     : statusText（string 或 string[] 多条轮播），或 win.setStatus() 动态改
 *   状态栏右侧 : #status-right 插槽（放「就绪 / 进度 / 版本号」）
 *
 * ── 加功能的标准入口（不会越加越跑不起来）────────────────────────────────────
 *   1. 命令   : win.on('file.new', fn) 注册；也可继续用 @command 事件
 *   2. 菜单   : win.addMenu({ id,label,accel,items }) 增量加菜单，不用重写整份 menus
 *   3. 界面   : 默认插槽放业务 UI（<RouterView />）
 *   4. 状态栏 : win.setStatus() 或 #status-right 插槽
 *   内置命令（win.* / shell.*）永远优先执行，业务注册不会覆盖窗口控制，保证外壳不被改坏。
 *
 * ── 命令 id 约定 ────────────────────────────────────────────────────────────
 *   'win.*'    窗口控制（框架内部处理）
 *   'shell.*'  外壳功能（弹窗 / 主题 / 状态栏，框架内部处理）
 *   其他       业务命令，通过 command 事件冒泡给宿主，由业务层后期实现
 * ========================================================================== */

/** 菜单条目：普通项 / 分隔线 / 勾选项 / 危险项 / 带子菜单项 / 分组标题 / 禁用项 */
export interface MenuItem {
  /** 唯一 id，同时作为命令 id，如 'file.new' */
  id: string
  label?: string
  /** 文案的 i18n key；传了优先于 label，切语言时自动跟随（用法见 src/i18n） */
  labelKey?: string
  /** i18n 占位符参数，配合 labelKey 使用，如 { email: 'a@b.com' } */
  labelParams?: Record<string, string | number>
  /** Font Awesome 图标类名，如 'fa-regular fa-file' */
  icon?: string
  /** 右侧快捷键提示，如 'Ctrl+N'（同时会被自动注册为全局快捷键） */
  shortcut?: string
  /** 分隔线（id 仍需唯一） */
  separator?: boolean
  /** 左侧勾选标记；传函数可跟随状态动态变化，如 () => showStatusBar.value */
  checked?: boolean | (() => boolean)
  /** 危险操作（退出等），hover 变红 */
  danger?: boolean
  /** 禁用项 */
  disabled?: boolean
  /** 子菜单（无限层级，hover 展开 flyout） */
  children?: MenuItem[]
  /** 分组小标题（右键菜单用，如 '快捷指令'） */
  groupTitle?: string
  /** 分组标题的 i18n key，优先于 groupTitle */
  groupTitleKey?: string
}

/** 顶部菜单栏中的一个菜单，如 文件(F) */
export interface MenuDef {
  id: string
  label?: string
  /** 文案的 i18n key；传了优先于 label，切语言时自动跟随 */
  labelKey?: string
  /** Alt 访问字母，带下划线显示，如 'F' */
  accel: string
  items: MenuItem[]
  /** 下拉面板宽度 class，如 'w-56' / 'w-52' */
  width?: string
}

/** 版本清单条目 */
export interface ReleaseNote {
  version: string
  desc: string
  /** 当前版本（高亮蓝色） */
  current?: boolean
}

/**
 * 品牌信息 —— 完整版把标题、LOGO、软件名、版本号一次性换掉。
 * 与 title / appIcon / appName / version 这些独立 prop 并存：brand 优先，旧 prop 作为回退。
 */
export interface BrandConfig {
  /** 标题栏居中标题 + 状态栏默认文本 */
  title?: string
  /** LOGO 图片地址（png / svg / 也可传 Tauri 的 asset:// 路径）；传了就用 <img> */
  logo?: string
  /** 无 LOGO 图片时的 Font Awesome 图标类，如 'fa-solid fa-layer-group' */
  icon?: string
  /** 关于弹窗里的软件名 */
  appName?: string
  /** 版本号，如 'v1.2.0' */
  version?: string
}

/** 关于弹窗内容（完整版替换；要完全自定义布局请用 #about 插槽） */
export interface AboutConfig {
  /** 软件一句话简介 */
  description?: string
  /** 版权信息，显示在底部 */
  copyright?: string
  /** 信息行，如 [{ label: '官网', value: 'https://...' }]；不传则用内置默认行 */
  meta?: { label: string; value: string }[]
}
</script>

<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { FunctionalComponent } from 'vue'

import { t, locale, setLocale, SUPPORTED_LOCALES } from '../i18n'

// =============================================================================
// 一、Props / Emits
// =============================================================================
const props = withDefaults(
  defineProps<{
    /** 标题栏居中标题 + 状态栏跑马灯默认文本 */
    title?: string
    /** 应用图标（Font Awesome 类名） */
    appIcon?: string
    /** LOGO 图片地址；传了优先于 appIcon */
    logo?: string
    /** 品牌信息（推荐：完整版一次性替换标题/LOGO/软件名/版本号） */
    brand?: BrandConfig
    /** 关于弹窗内容；要完全自定义布局用 #about 插槽 */
    about?: AboutConfig
    /** 关于弹窗里的软件名 */
    appName?: string
    /** 当前版本号 */
    version?: string
    /** 状态栏文本，默认取 title；传数组则多条轮播 */
    statusText?: string | string[]
    /** 初始主题（code.html 为浅色） */
    defaultTheme?: 'light' | 'dark'
    /** 初始是否显示底部状态栏 */
    statusBarVisible?: boolean
    /** 顶部菜单栏配置；不传则用内置通用配置 */
    menus?: MenuDef[]
    /** 客户区右键菜单配置；不传则用内置通用配置 */
    contextMenu?: MenuItem[]
    /** 「帮助」菜单下的菜单项；完整版换成「使用文档 / 检查更新 / 反馈」等 */
    helpItems?: MenuItem[]
    /** 版本清单 */
    releases?: ReleaseNote[]
    /** 关闭窗口时的行为：最小化到托盘 / 直接退出（宿主负责落盘与 Rust 同步） */
    closeBehavior?: 'tray' | 'quit'
  }>(),
  {
    title: 'BaseWindow',
    appIcon: 'fa-solid fa-layer-group',
    logo: '',
    brand: undefined,
    about: undefined,
    appName: 'BaseWindow',
    version: 'v0.5.0-release',
    statusText: '',
    defaultTheme: 'light',
    statusBarVisible: true,
    menus: undefined,
    contextMenu: undefined,
    helpItems: undefined,
    releases: undefined,
    closeBehavior: 'tray',
  },
)

/**
 * 业务命令冒泡。框架不认识的 id（不以 win. / shell. 开头）都会走到这里，
 * 宿主在 App.vue 里统一 switch 处理即可。
 */
const emit = defineEmits<{
  (e: 'command', id: string): void
  (e: 'update:closeBehavior', v: 'tray' | 'quit'): void
}>()

// =============================================================================
// 二、外壳状态（主题 / 状态栏开关 用 localStorage 记忆，跨重启保持用户选择）
// =============================================================================
const UI_STORAGE_KEY = 'basewindow:ui'
function loadUiState(): { theme?: 'light' | 'dark'; statusBar?: boolean } {
  try {
    return JSON.parse(localStorage.getItem(UI_STORAGE_KEY) || '{}') ?? {}
  } catch {
    return {}
  }
}
function saveUiState() {
  try {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({
      theme: isDark.value ? 'dark' : 'light',
      statusBar: showStatusBar.value,
    }))
  } catch {
    /* 隐私模式 / 存储不可用时静默跳过，不影响外壳运行 */
  }
}

const _ui = loadUiState()
const isDark = ref(_ui.theme ? _ui.theme === 'dark' : props.defaultTheme === 'dark')
const showStatusBar = ref(_ui.statusBar == null ? props.statusBarVisible : _ui.statusBar === true)
const showSettings = ref(false)
const showAbout = ref(false)
const showVersion = ref(false)

/** 设置弹窗里的两个开关（预留，后期接真实配置项） */
const acrylic = ref(true)
const hardwareAccel = ref(true)

// ── 品牌解析：brand 优先、旧 prop 回退（老用法 title/appIcon 仍然有效）──────
const brand = computed<BrandConfig>(() => props.brand ?? {})
const appTitle = computed(() => brand.value.title ?? props.title)
const logoUrl = computed(() => brand.value.logo ?? props.logo ?? '')
const iconClass = computed(() => brand.value.icon ?? props.appIcon)
const appNameText = computed(() => brand.value.appName ?? props.appName)
const versionText = computed(() => brand.value.version ?? props.version)

// ── 状态栏：单条 / 多条轮播 / 运行时覆盖 ─────────────────────────────────
const statusOverride = ref<string[] | null>(null)
const statusList = computed<string[]>(() => {
  const src = statusOverride.value ?? props.statusText
  if (Array.isArray(src)) return src.length ? src : [appTitle.value]
  return [src || appTitle.value]
})
const statusIndex = ref(0)
let statusTimer: ReturnType<typeof setInterval> | undefined

function stopStatusRotation() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = undefined }
}
function startStatusRotation() {
  stopStatusRotation()
  if (statusList.value.length <= 1) return
  statusTimer = setInterval(() => {
    statusIndex.value = (statusIndex.value + 1) % statusList.value.length
  }, 6000)
}
watch(statusList, () => { statusIndex.value = 0; startStatusRotation() }, { immediate: true })
onUnmounted(stopStatusRotation)

/** 完整版运行时改状态栏文案：win.setStatus('就绪') 或 win.setStatus(['A','B']) */
function setStatus(text: string | string[]) {
  statusOverride.value = Array.isArray(text) ? [...text] : [text]
}

// ── 关于弹窗内容（完整版替换；要改布局用 #about 插槽）────────────────────
const aboutInfo = computed<AboutConfig>(() => props.about ?? {})
const aboutMeta = computed(() => aboutInfo.value.meta ?? [
  { label: 'about.meta.design', value: 'Win11 Fluent & Light Clean' },
  { label: 'about.meta.source', value: 'src/layouts/BaseWindow.vue' },
  { label: 'about.meta.stack', value: 'Vue 3 / Tauri 2 / Rust' },
  { label: 'about.meta.version', value: versionText.value },
])

const releaseList = computed<ReleaseNote[]>(
  () =>
    props.releases ?? [
      { version: 'v0.5.0-release (当前浅色纯净版)', desc: 'release.v050', current: true },
      { version: 'v0.4.2-alpha', desc: 'release.v042' },
    ],
)

// =============================================================================
// 三、Tauri 2 窗口控制（浏览器 / vite dev 下自动降级为日志，不报错）
// =============================================================================
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const isMaximized = ref(false)
const isFullscreen = ref(false)

/** 延迟动态导入：纯浏览器演示时不会因缺少 Tauri 注入而崩溃 */
async function tauriWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

async function minimize() {
  if (isTauri) return (await tauriWindow()).minimize()
  console.info('[BaseWindow][demo] 最小化')
}
async function toggleMaximize() {
  if (isTauri) {
    const w = await tauriWindow()
    await w.toggleMaximize()
    isMaximized.value = await w.isMaximized()
    return
  }
  isMaximized.value = !isMaximized.value
  console.info('[BaseWindow][demo] 最大化/还原:', isMaximized.value)
}
async function close() {
  if (isTauri) return (await tauriWindow()).close()
  console.info('[BaseWindow][demo] 关闭窗口')
}
async function toggleFullscreen() {
  if (isTauri) {
    const w = await tauriWindow()
    await w.setFullscreen(!isFullscreen.value)
    isFullscreen.value = await w.isFullscreen()
    return
  }
  isFullscreen.value = !isFullscreen.value
  console.info('[BaseWindow][demo] 全屏:', isFullscreen.value)
}
async function openDevtools() {
  if (!isTauri) {
    console.info('[BaseWindow][demo] DevTools（浏览器请直接按 F12）')
    return
  }
  // 注意：Tauri 2.11 的 JS API 已移除 openDevtools()，改由 Rust command 提供
  // 对应实现见 src-tauri/src/lib.rs 的 open_devtools（release 构建下为空操作）
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('open_devtools')
  } catch (err) {
    console.warn('[BaseWindow] DevTools 不可用（release 构建或未注册 open_devtools 命令）', err)
  }
}

let unlistenResize: (() => void) | undefined
onMounted(async () => {
  if (!isTauri) return
  const w = await tauriWindow()
  isMaximized.value = await w.isMaximized()
  // 覆盖 Win+Up、拖到屏幕边缘、任务栏操作等系统级最大化
  unlistenResize = await w.onResized(async () => {
    isMaximized.value = await w.isMaximized()
  })
})
onUnmounted(() => unlistenResize?.())

// =============================================================================
// 四、内置菜单配置（严格对照 code.html；换软件时改这里，或外部传 :menus）
// =============================================================================
function buildDefaultMenus(): MenuDef[] {
  return [
    {
      id: 'menu-file',
      label: t('menu.file'),
      accel: 'F',
      width: 'w-56',
      items: [
        { id: 'file.new', labelKey: 'cmd.file.new', icon: 'fa-regular fa-file', shortcut: 'Ctrl+N' },
        { id: 'file.open', labelKey: 'cmd.file.open', icon: 'fa-regular fa-folder-open', shortcut: 'Ctrl+O' },
        { id: 'file.sep1', separator: true },
        { id: 'file.save', labelKey: 'cmd.file.save', icon: 'fa-regular fa-floppy-disk', shortcut: 'Ctrl+S' },
        { id: 'file.sep2', separator: true },
        { id: 'win.close', labelKey: 'cmd.win.close', icon: 'fa-solid fa-power-off', shortcut: 'Alt+F4', danger: true },
      ],
    },
    {
      id: 'menu-edit',
      label: t('menu.edit'),
      accel: 'E',
      width: 'w-52',
      items: [
        { id: 'edit.undo', labelKey: 'cmd.edit.undo', shortcut: 'Ctrl+Z' },
        { id: 'edit.redo', labelKey: 'cmd.edit.redo', shortcut: 'Ctrl+Y' },
        { id: 'edit.sep1', separator: true },
        { id: 'edit.cut', labelKey: 'cmd.edit.cut', shortcut: 'Ctrl+X' },
        { id: 'edit.copy', labelKey: 'cmd.edit.copy', shortcut: 'Ctrl+C' },
        { id: 'edit.paste', labelKey: 'cmd.edit.paste', shortcut: 'Ctrl+V' },
      ],
    },
    {
      id: 'menu-view',
      label: t('menu.view'),
      accel: 'V',
      width: 'w-52',
      items: [
        // checked 传函数 → 勾选状态随 showStatusBar 实时变化
        { id: 'shell.toggle-statusbar', labelKey: 'cmd.view.statusbar', icon: 'fa-solid fa-check', checked: () => showStatusBar.value },
        { id: 'shell.toggle-theme', labelKey: 'cmd.view.theme', icon: 'fa-solid fa-circle-half-stroke' },
        { id: 'view.sep1', separator: true },
        { id: 'win.fullscreen', labelKey: 'cmd.win.fullscreen', shortcut: 'F11' },
      ],
    },
    {
      id: 'menu-settings',
      label: t('menu.settings'),
      accel: 'S',
      width: 'w-56',
      items: [
        { id: 'shell.settings', labelKey: 'cmd.shell.settings', icon: 'fa-solid fa-sliders' },
        { id: 'shell.toggle-theme', labelKey: 'cmd.shell.appearance', icon: 'fa-solid fa-palette' },
      ],
    },
    {
      id: 'menu-help',
      label: t('menu.help'),
      accel: 'H',
      width: 'w-52',
      items: props.helpItems ?? [
        { id: 'shell.about', labelKey: 'cmd.shell.about', icon: 'fa-solid fa-circle-info' },
        { id: 'shell.version', labelKey: 'cmd.shell.version', icon: 'fa-solid fa-code-branch' },
      ],
    },
  ]
}

/** 客户区右键菜单（对照 code.html：快捷指令分组 + 三个外壳入口） */
function buildDefaultContextMenu(): MenuItem[] {
  return [
    { id: 'ctx.group', groupTitleKey: 'ctx.group' },
    { id: 'view.refresh', labelKey: 'cmd.view.refresh', icon: 'fa-solid fa-arrow-rotate-right', shortcut: 'F5' },
    { id: 'win.devtools', labelKey: 'cmd.win.devtools', icon: 'fa-solid fa-terminal', shortcut: 'F12' },
    { id: 'ctx.sep1', separator: true },
    { id: 'shell.settings', labelKey: 'cmd.shell.settingsShort', icon: 'fa-solid fa-gear' },
    { id: 'shell.about', labelKey: 'cmd.shell.aboutShort', icon: 'fa-solid fa-circle-info' },
    { id: 'shell.version', labelKey: 'cmd.shell.versionShort', icon: 'fa-solid fa-code-branch' },
  ]
}

/** 增量菜单：由 win.addMenu() 追加，不必重写整份 menus */
const extraMenus = ref<MenuDef[]>([])
const menus = computed<MenuDef[]>(() => [...(props.menus ?? buildDefaultMenus()), ...extraMenus.value])
const contextMenuItems = computed(() => props.contextMenu ?? buildDefaultContextMenu())

/** 加一个新菜单（如「工具(T)」）；返回 false 表示 id 重复已忽略 */
function addMenu(menu: MenuDef, position?: number) {
  if (menus.value.some((m) => m.id === menu.id)) {
    console.warn(`[BaseWindow] 菜单 id 已存在，已忽略：${menu.id}`)
    return false
  }
  if (position == null) extraMenus.value.push(menu)
  else extraMenus.value.splice(Math.max(0, position), 0, menu)
  return true
}

/** dev 自检：菜单 id 重复会让快捷键和命令串台，提前告警而不是等它悄悄失效 */
function validateMenus(list: MenuDef[]) {
  const seen = new Set<string>()
  const walk = (items: MenuItem[], path: string) => {
    for (const it of items) {
      if (!it.id || seen.has(it.id)) console.warn(`[BaseWindow] 菜单项 id 缺失或重复：${path} → ${it.id}`)
      seen.add(it.id)
      if (it.children?.length) walk(it.children, `${path}/${it.id}`)
    }
  }
  list.forEach((m) => walk(m.items, m.id))
}
if (import.meta.env.DEV) watch(menus, (v) => validateMenus(v), { immediate: true })

// =============================================================================
// 五、菜单开合 + 子菜单路径（同时只允许一条链路展开）
// =============================================================================
const openMenuId = ref<string | null>(null)
/** subPath[depth] = 该层级当前展开的条目 id；hover 更深层级不会误关父级 */
const subPath = ref<string[]>([])

function toggleMenu(id: string) {
  hideContextMenu()
  openMenuId.value = openMenuId.value === id ? null : id
  subPath.value = []
}
function openSub(depth: number, id: string) {
  subPath.value = subPath.value.slice(0, depth).concat(id)
}

// =============================================================================
// 六、右键上下文菜单（定位 + 边界溢出保护，与 code.html 算法一致）
// =============================================================================
const clientArea = shallowRef<HTMLElement | null>(null)
const ctxVisible = ref(false)
const ctxX = ref(0)
const ctxY = ref(0)
const CTX_W = 210
const CTX_H = 220

function openContextMenu(e: MouseEvent) {
  e.preventDefault()
  closeAllPopups()
  const rect = clientArea.value?.getBoundingClientRect()
  if (!rect) return
  let x = e.clientX - rect.left
  let y = e.clientY - rect.top
  if (x + CTX_W > rect.width) x = rect.width - CTX_W - 8
  if (y + CTX_H > rect.height) y = rect.height - CTX_H - 8
  ctxX.value = Math.max(8, x)
  ctxY.value = Math.max(8, y)
  ctxVisible.value = true
}
function hideContextMenu() {
  ctxVisible.value = false
}
function closeAllPopups() {
  openMenuId.value = null
  subPath.value = []
  hideContextMenu()
}

// =============================================================================
// 七、命令总线：win.* / shell.* 内部处理，其余冒泡给业务层
// =============================================================================
/** 内置命令：窗口控制 + 外壳功能。业务注册的同名命令不会覆盖它们。 */
const commandHandlers: Record<string, () => void> = {
  'win.minimize': minimize,
  'win.maximize': toggleMaximize,
  'win.close': close,
  'win.fullscreen': toggleFullscreen,
  'win.devtools': openDevtools,

  'shell.settings': () => { showSettings.value = true },
  'shell.about': () => { showAbout.value = true },
  'shell.version': () => { showVersion.value = true },
  'shell.toggle-theme': () => { isDark.value = !isDark.value },
  'shell.toggle-statusbar': () => { showStatusBar.value = !showStatusBar.value },
}

/** 业务命令注册表：加功能就是 win.on('xxx', fn) 一行，不改框架、不堆 switch */
type CommandHandler = (id: string) => void
const registered = new Map<string, Set<CommandHandler>>()

/** 注册命令处理器，返回「取消注册」函数 */
function on(id: string, handler: CommandHandler): () => void {
  let set = registered.get(id)
  if (!set) { set = new Set(); registered.set(id, set) }
  set.add(handler)
  return () => off(id, handler)
}
function off(id: string, handler?: CommandHandler) {
  if (!handler) { registered.delete(id); return }
  registered.get(id)?.delete(handler)
}
onUnmounted(() => registered.clear())

function runCommand(id: string) {
  // 选中菜单项/右键项后先收起所有弹出层，再执行
  closeAllPopups()

  // 1) 内置命令（窗口控制 / 外壳）永远优先 —— 业务改不坏外壳
  const builtin = commandHandlers[id]
  if (builtin) { builtin(); return }

  // 2) 业务通过 win.on() 注册的命令
  const set = registered.get(id)
  if (set?.size) {
    for (const fn of [...set]) fn(id) // 拷贝一份，避免处理器内部注销导致遍历异常
    return
  }

  // 3) 都没接管 → 冒泡给宿主（@command）；dev 下提示接法，避免「点了没反应」却查不到原因
  if (import.meta.env.DEV) console.info(`[BaseWindow] 命令「${id}」尚未实现：用 win.on('${id}', fn) 注册，或监听 @command`)
  emit('command', id)
}

// =============================================================================
// 八、全局快捷键（由菜单配置反向生成：改菜单即改快捷键）
// =============================================================================
const shortcutMap = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {}
  const walk = (items: MenuItem[]) => {
    for (const it of items) {
      if (it.separator || it.groupTitle) continue
      if (it.shortcut) map[it.shortcut] = it.id
      if (it.children?.length) walk(it.children)
    }
  }
  menus.value.forEach((m) => walk(m.items))
  walk(contextMenuItems.value)
  return map
})

/**
 * 设置弹窗「快捷键总表」数据源：同时覆盖菜单项的定义快捷键 + 固定快捷键（F5/F11/F12）。
 * conflict 标记同一组合键被多项占用，便于用户一眼看出冲突并调整。
 */
interface ShortcutEntry { id: string; shortcut: string; label: string; conflict: boolean }
const FIXED_SHORTCUTS: { id: string; shortcut: string; key: string }[] = [
  { id: 'view.refresh', shortcut: 'F5', key: 'cmd.view.refresh' },
  { id: 'win.fullscreen', shortcut: 'F11', key: 'cmd.win.fullscreen' },
  { id: 'win.devtools', shortcut: 'F12', key: 'cmd.win.devtools' },
]
const shortcutList = computed<ShortcutEntry[]>(() => {
  const entries: Omit<ShortcutEntry, 'conflict'>[] = []
  const collect = (items: MenuItem[]) => {
    for (const it of items) {
      if (it.separator || it.groupTitle) continue
      if (it.shortcut) {
        const label = it.labelKey ? t(it.labelKey, it.labelParams) : it.label ?? ''
        entries.push({ id: it.id, shortcut: it.shortcut, label })
      }
      if (it.children?.length) collect(it.children)
    }
  }
  menus.value.forEach((m) => collect(m.items))
  collect(contextMenuItems.value)
  FIXED_SHORTCUTS.forEach((f) => entries.push({ id: f.id, shortcut: f.shortcut, label: t(f.key) }))
  // 冲突检测：同一 shortcut 被多项占用即标红
  const counts = new Map<string, number>()
  for (const e of entries) counts.set(e.shortcut, (counts.get(e.shortcut) ?? 0) + 1)
  return entries.map((e) => ({ ...e, conflict: (counts.get(e.shortcut) ?? 0) > 1 }))
})

function onKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null
  const typing = !!target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)

  if (e.key === 'Escape') { closeAllPopups(); return }
  // F5/F11/F12 不依赖菜单配置，固定绑定
  if (e.key === 'F5') { e.preventDefault(); runCommand('view.refresh'); return }
  if (e.key === 'F11') { e.preventDefault(); runCommand('win.fullscreen'); return }
  if (e.key === 'F12') { e.preventDefault(); runCommand('win.devtools'); return }

  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
  const combo = parts.join('+')

  const mapped = shortcutMap.value[combo]
  // 输入框内放行系统编辑键，避免破坏原生复制粘贴
  const passthrough = ['Ctrl+C', 'Ctrl+X', 'Ctrl+V', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+A']
  if (mapped && !(typing && passthrough.includes(combo))) {
    e.preventDefault()
    runCommand(mapped)
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

// 主题同步到 <html>（后期用 Teleport 挂到 body 的业务弹窗也能继承 dark）；
// 同时持久化主题 / 状态栏开关，跨重启保持用户选择
watch(isDark, (v) => document.documentElement.classList.toggle('dark', v), { immediate: true })
watch([isDark, showStatusBar], saveUiState)
// 标题同步到 document.title：浏览器标签页 / Tauri 原生窗口标题与标题栏保持一致
watch(appTitle, (v) => { if (v) document.title = v }, { immediate: true })

// =============================================================================
// 九、菜单项递归渲染（函数式组件：支持无限层级子菜单）
// =============================================================================
interface MenuNodeProps { item: MenuItem; depth: number }

const MenuNode: FunctionalComponent<MenuNodeProps> = (props_) => {
  const it = props_.item
  const depth = props_.depth

  if (it.separator) return h('div', { class: 'my-1 border-t border-slate-200 dark:border-zinc-700' })

  const groupTitleText = it.groupTitleKey ? t(it.groupTitleKey) : it.groupTitle
  if (groupTitleText) {
    return h('div', { class: 'px-3 py-1 text-[10px] text-slate-400 font-semibold uppercase tracking-wider' }, groupTitleText)
  }

  const isChecked = typeof it.checked === 'function' ? it.checked() : it.checked === true
  const hasSub = !!it.children?.length
  const isOpen = subPath.value[depth] === it.id

  // 左侧图标：勾选项优先显示 ✓，否则用配置图标
  const iconClass = it.icon && !isChecked ? it.icon : 'fa-solid fa-check'
  const left = h('span', { class: 'flex items-center gap-2' }, [
    isChecked || it.icon
      ? h('i', { class: [iconClass, 'w-4 text-xs', 'text-slate-400 group-hover:text-white'] })
      : null,
    it.labelKey ? t(it.labelKey, it.labelParams) : it.label,
  ])

  const right = it.shortcut
    ? h('span', {
        class: ['text-[10px] font-mono', it.danger ? 'text-slate-400 group-hover:text-red-100' : 'text-slate-400 group-hover:text-blue-100'],
      }, it.shortcut)
    : hasSub
      ? h('i', { class: 'fa-solid fa-chevron-right text-[9px] text-slate-400 group-hover:text-white' })
      : null

  const button = h(
    'button',
    {
      class: [
        'w-full px-3 py-1.5 text-left flex items-center justify-between group',
        it.disabled ? 'opacity-40 pointer-events-none' : '',
        !it.disabled && it.danger ? 'text-slate-700 hover:bg-red-600 hover:text-white' : '',
        !it.disabled && !it.danger ? 'hover:bg-blue-600 hover:text-white' : '',
      ],
      onClick: (e: MouseEvent) => {
        e.stopPropagation()
        if (it.disabled) return
        if (!hasSub) runCommand(it.id)
      },
      onMouseenter: () => {
        if (hasSub) openSub(depth, it.id)
        else if (subPath.value.length > depth) subPath.value = subPath.value.slice(0, depth)
      },
    },
    [left, right],
  )

  const flyout = hasSub
    ? h(
        'div',
        {
          class: [
            'absolute left-full top-0 mt-[-2px] ml-0.5 w-48 bg-white dark:bg-zinc-800',
            'border border-slate-200 dark:border-zinc-700 rounded-md shadow-xl py-1',
            'text-slate-700 dark:text-zinc-200 z-50',
            isOpen ? 'block' : 'hidden',
          ],
        },
        it.children!.map((c) => h(MenuNode, { item: c, depth: depth + 1 })),
      )
    : null

  return h('div', { class: 'relative' }, [button, flyout])
}

// =============================================================================
// 十、对外暴露命令式接口（宿主用 ref 拿到）
//   win.on('file.new', fn)      注册业务命令（推荐，替代大 switch）
//   win.addMenu({...})          增量加菜单
//   win.setStatus('就绪')       动态改状态栏
//   win.runCommand('shell.about') 代码里主动触发命令
// =============================================================================
defineExpose({
  runCommand, on, off, addMenu, setStatus,
  closeAllPopups, isDark, showStatusBar, isMaximized,
  // 便捷方法：完整版常用
  openAbout: () => { showAbout.value = true },
  openSettings: () => { showSettings.value = true },
  openVersion: () => { showVersion.value = true },
})
</script>

<template>
  <!-- 主题 class 必须挂在祖先节点：Tailwind 的 dark: 变体匹配 .dark 的后代 -->
  <div class="w-full h-full" :class="{ dark: isDark }">
    <!-- 窗口本体：占满 Tauri 无边框窗口视口 -->
    <div
      class="w-full h-full bg-white dark:bg-zinc-900 flex flex-col relative text-slate-800 dark:text-zinc-100 overflow-hidden"
      @click="closeAllPopups"
    >
      <!-- 1. 标题栏 / 非客户区（data-tauri-drag-region 让整条栏可拖动窗口） -->
      <header
        data-tauri-drag-region
        class="h-10 bg-slate-100 dark:bg-zinc-800 border-b border-slate-200 dark:border-zinc-700
               flex items-center justify-between px-3 select-none relative shrink-0"
      >
        <!-- 左：应用图标 + 菜单栏 -->
        <div class="flex items-center gap-1.5 z-10" @click.stop>
          <!-- LOGO：完整版传 brand.logo（图片地址）即可换成自己的图标；没有图片时回退 Font Awesome -->
          <img
            v-if="logoUrl"
            :src="logoUrl"
            class="w-5 h-5 rounded object-contain mr-1 select-none"
            draggable="false"
            alt="logo"
          >
          <div v-else class="w-5 h-5 rounded bg-blue-600 flex items-center justify-center text-white shadow-sm text-xs mr-1">
            <i :class="iconClass" class="text-[10px]" />
          </div>
          <div class="flex items-center gap-0.5 text-xs select-none text-slate-700 dark:text-zinc-200">
            <div v-for="menu in menus" :key="menu.id" class="relative">
              <button
                class="px-2 py-1 rounded text-slate-700 dark:text-zinc-200 hover:bg-slate-200 dark:hover:bg-zinc-700
                       hover:text-slate-900 dark:hover:text-white transition-colors flex items-center gap-0.5"
                :class="openMenuId === menu.id ? 'bg-slate-200 dark:bg-zinc-700 text-slate-900 dark:text-white' : ''"
                @click.stop="toggleMenu(menu.id)"
              >
                {{ menu.labelKey ? t(menu.labelKey) : menu.label }}<span class="text-slate-400 underline decoration-slate-400">{{ menu.accel }}</span>
              </button>

              <!-- 下拉面板 -->
              <div
                v-show="openMenuId === menu.id"
                class="absolute left-0 top-full mt-1 bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700
                       rounded-md shadow-xl py-1 text-slate-700 dark:text-zinc-200 z-50"
                :class="menu.width ?? 'w-56'"
                @click.stop
              >
                <MenuNode v-for="item in menu.items" :key="item.id" :item="item" :depth="0" />
              </div>
            </div>
          </div>
        </div>

        <!-- 中：标题（pointer-events-none，不遮挡菜单点击） -->
        <div class="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
          <span class="text-xs font-semibold tracking-wide text-slate-800 dark:text-zinc-100">{{ appTitle }}</span>
        </div>

        <!-- 右：主题切换 + 窗口控制按钮 -->
        <div class="flex items-center z-10" @click.stop>
          <button
            class="h-8 px-2.5 mr-1 text-xs rounded inline-flex items-center gap-1 text-slate-600 dark:text-zinc-300
                   hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
            :title="t('titlebar.theme')"
            @click="runCommand('shell.toggle-theme')"
          >
            <i class="text-amber-500" :class="isDark ? 'fa-solid fa-moon' : 'fa-solid fa-sun'" />
            <span class="text-[11px] font-medium hidden sm:inline">{{ isDark ? t('titlebar.themeDark') : t('titlebar.themeLight') }}</span>
          </button>
          <div class="h-4 w-[1px] bg-slate-200 dark:bg-zinc-700 mx-1" />

          <button
            class="w-10 h-10 inline-flex items-center justify-center text-slate-600 dark:text-zinc-300
                   hover:bg-slate-200 dark:hover:bg-zinc-700 hover:text-slate-900 dark:hover:text-white transition-colors"
            :title="t('titlebar.minimize')" @click="runCommand('win.minimize')"
          >
            <i class="fa-solid fa-minus text-xs" />
          </button>
          <button
            class="w-10 h-10 inline-flex items-center justify-center text-slate-600 dark:text-zinc-300
                   hover:bg-slate-200 dark:hover:bg-zinc-700 hover:text-slate-900 dark:hover:text-white transition-colors"
            :title="isMaximized ? t('titlebar.restore') : t('titlebar.maximize')" @click="runCommand('win.maximize')"
          >
            <i class="text-xs" :class="isMaximized ? 'fa-regular fa-window-restore' : 'fa-regular fa-square'" />
          </button>
          <button
            class="w-10 h-10 inline-flex items-center justify-center text-slate-600 dark:text-zinc-300
                   hover:bg-red-600 hover:text-white transition-colors"
            :title="t('titlebar.close')" @click="runCommand('win.close')"
          >
            <i class="fa-solid fa-xmark text-sm" />
          </button>
        </div>
      </header>

      <!-- 2. 客户区：半成品阶段不实现任何业务内容，仅提供挂载槽位 -->
      <main
        ref="clientArea"
        class="flex-1 bg-[#fafafa] dark:bg-zinc-900 flex overflow-hidden relative"
        @contextmenu="openContextMenu"
      >
        <div class="client-grid flex-1 w-full h-full relative flex items-center justify-center select-none overflow-hidden">
          <!-- ===== 业务挂载点：<RouterView /> 或具体工具界面，后期在这里填充 ===== -->
          <slot />
        </div>

        <!-- 3. 右键上下文菜单 -->
        <div
          v-show="ctxVisible"
          class="absolute w-52 bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700
                 rounded-lg shadow-2xl py-1.5 text-xs text-slate-700 dark:text-zinc-200 z-50"
          :style="{ left: `${ctxX}px`, top: `${ctxY}px` }"
          @click.stop
          @contextmenu.prevent
        >
          <MenuNode v-for="item in contextMenuItems" :key="item.id" :item="item" :depth="0" />
        </div>
      </main>

      <!-- 4. 底部状态栏（跑马灯） -->
      <footer
        v-if="showStatusBar"
        class="h-6 bg-slate-100 dark:bg-zinc-800 border-t border-slate-200 dark:border-zinc-700 px-3
               flex items-center justify-between text-[11px] text-slate-500 dark:text-zinc-400 select-none shrink-0"
      >
        <div class="w-full h-full overflow-hidden relative flex items-center">
          <div class="status-marquee text-[11px] text-slate-600 dark:text-zinc-300 font-medium tracking-wider">
            {{ statusList[statusIndex] }}
          </div>
        </div>
        <!-- 状态栏右侧扩展位：完整版放「就绪 / 进度 / 版本号」等固定信息 -->
        <div v-if="$slots['status-right']" class="ml-3 shrink-0 flex items-center gap-2">
          <slot name="status-right" />
        </div>
      </footer>

      <!-- 5. 设置弹窗 -->
      <div
        v-show="showSettings"
        class="absolute inset-0 bg-slate-900/40 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
        @click.self="showSettings = false"
      >
        <div class="w-full max-w-md bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-xl shadow-2xl p-6 text-slate-800 dark:text-zinc-100">
          <div class="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-zinc-700 mb-4">
            <div class="flex items-center gap-2 font-medium text-sm">
              <i class="fa-solid fa-gear text-blue-600" />
              <span>{{ t('settings.title') }}</span>
            </div>
            <button class="text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200" @click="showSettings = false">
              <i class="fa-solid fa-xmark" />
            </button>
          </div>
          <!-- 设置内容：完整版用 #settings 插槽整体替换，下面只是半成品占位开关 -->
          <slot name="settings">
            <div class="space-y-4 text-xs">
              <div class="flex items-center justify-between">
                <div>
                  <div class="font-medium">{{ t('settings.acrylic') }}</div>
                <div class="text-slate-500 dark:text-zinc-400 text-[11px]">{{ t('settings.acrylicDesc') }}</div>
              </div>
              <input v-model="acrylic" type="checkbox" class="rounded border-slate-300 text-blue-600 focus:ring-0">
            </div>
            <div class="flex items-center justify-between">
              <div>
                <div class="font-medium">{{ t('settings.hardware') }}</div>
                <div class="text-slate-500 dark:text-zinc-400 text-[11px]">{{ t('settings.hardwareDesc') }}</div>
              </div>
              <input v-model="hardwareAccel" type="checkbox" class="rounded border-slate-300 text-blue-600 focus:ring-0">
            </div>
            <div class="flex items-center justify-between">
              <div>
                <div class="font-medium">{{ t('settings.theme') }}</div>
                <div class="text-slate-500 dark:text-zinc-400 text-[11px]">{{ t('settings.themeDesc', { theme: isDark ? t('settings.themeDarkDesc') : t('settings.themeLightDesc') }) }}</div>
              </div>
              <span class="px-2 py-0.5 rounded bg-blue-50 text-blue-600 font-medium text-[11px] border border-blue-200">
                {{ isDark ? t('settings.themeDarkValue') : t('settings.themeLightValue') }}
              </span>
            </div>

            <!-- 界面语言：切换后立即生效，写入 localStorage 跨重启保持 -->
            <div class="flex items-center justify-between">
              <div>
                <div class="font-medium">{{ t('settings.language') }}</div>
                <div class="text-slate-500 dark:text-zinc-400 text-[11px]">{{ t('settings.languageDesc') }}</div>
              </div>
              <div class="flex gap-1">
                <button
                  v-for="l in SUPPORTED_LOCALES"
                  :key="l.code"
                  class="px-2 py-0.5 rounded border text-[11px] font-medium transition-colors"
                  :class="locale === l.code
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'border-slate-200 dark:border-zinc-600 text-slate-600 dark:text-zinc-300 hover:border-blue-400'"
                  @click="setLocale(l.code)"
                >{{ l.label }}</button>
              </div>
            </div>

            <!-- 关闭行为：宿主通过 update:closeBehavior 同步到 Rust（托盘） -->
            <div class="flex items-center justify-between">
              <div>
                <div class="font-medium">{{ t('settings.closeBehavior') }}</div>
                <div class="text-slate-500 dark:text-zinc-400 text-[11px]">{{ t('settings.closeBehaviorDesc') }}</div>
              </div>
              <div class="flex gap-1">
                <button
                  v-for="opt in (['tray', 'quit'] as const)"
                  :key="opt"
                  class="px-2 py-0.5 rounded border text-[11px] font-medium transition-colors"
                  :class="props.closeBehavior === opt
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'border-slate-200 dark:border-zinc-600 text-slate-600 dark:text-zinc-300 hover:border-blue-400'"
                  @click="emit('update:closeBehavior', opt)"
                >{{ t(`settings.closeBehavior.${opt}`) }}</button>
              </div>
            </div>

            <!-- 快捷键总表：同一快捷键被多项占用即标红 -->
            <div>
              <div class="font-medium">{{ t('settings.shortcuts') }}</div>
              <div class="text-slate-500 dark:text-zinc-400 text-[11px]">{{ t('settings.shortcutsDesc') }}</div>
              <div class="mt-1.5 max-h-24 overflow-y-auto pr-1 space-y-0.5">
                <div v-for="s in shortcutList" :key="`${s.shortcut}-${s.id}`" class="flex items-center gap-2 text-[11px]">
                  <span class="font-mono text-slate-500 dark:text-zinc-400 shrink-0">{{ s.shortcut }}</span>
                  <span class="truncate flex-1 text-slate-600 dark:text-zinc-300">{{ s.label }}</span>
                  <span v-if="s.conflict" class="text-red-500 shrink-0">{{ t('settings.shortcutsConflict') }}</span>
                </div>
                <div v-if="!shortcutList.length" class="text-[11px] text-slate-400">{{ t('settings.shortcutsNone') }}</div>
              </div>
            </div>
            </div>
          </slot>
          <div class="mt-6 pt-3 border-t border-slate-100 dark:border-zinc-700 flex justify-end gap-2 text-xs">
            <button class="px-3 py-1.5 rounded bg-slate-100 dark:bg-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-600 font-medium"
                    @click="showSettings = false">{{ t('common.close') }}</button>
            <button class="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white font-medium"
                    @click="showSettings = false">{{ t('common.apply') }}</button>
          </div>
        </div>
      </div>

      <!-- 6. 关于弹窗 -->
      <div
        v-show="showAbout"
        class="absolute inset-0 bg-slate-900/40 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
        @click.self="showAbout = false"
      >
        <div class="w-full max-w-sm bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-xl shadow-2xl p-6 text-center">
          <!-- 关于内容：完整版用 #about 插槽整体替换；不换插槽也能用 about prop 改文案与信息行 -->
          <slot name="about">
            <img
              v-if="logoUrl"
              :src="logoUrl"
              class="w-14 h-14 mx-auto rounded-2xl object-contain shadow-md mb-3"
              draggable="false"
              alt="logo"
            >
            <div v-else class="w-14 h-14 mx-auto rounded-2xl bg-blue-600 flex items-center justify-center text-white text-2xl shadow-md mb-3">
              <i :class="iconClass" />
            </div>
            <h3 class="text-base font-semibold text-slate-900 dark:text-white">{{ appNameText }}</h3>
            <p class="text-xs text-slate-500 dark:text-zinc-400 mt-1">
              {{ t(aboutInfo.description || 'about.defaultDesc') }}
            </p>
            <div class="mt-4 p-3 bg-slate-50 dark:bg-zinc-900 rounded-lg text-left text-xs space-y-1.5 text-slate-600 dark:text-zinc-300 border border-slate-200 dark:border-zinc-700">
              <div v-for="row in aboutMeta" :key="row.label"><b>{{ t(row.label) }}</b> {{ t(row.value) }}</div>
            </div>
            <p v-if="aboutInfo.copyright" class="mt-3 text-[10px] text-slate-400 dark:text-zinc-500">
              {{ aboutInfo.copyright }}
            </p>
          </slot>
          <button class="mt-5 w-full py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-xs text-white font-medium transition-colors"
                  @click="showAbout = false">{{ t('common.confirm') }}</button>
        </div>
      </div>

      <!-- 7. 版本弹窗 -->
      <div
        v-show="showVersion"
        class="absolute inset-0 bg-slate-900/40 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
        @click.self="showVersion = false"
      >
        <div class="w-full max-w-sm bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-xl shadow-2xl p-6">
          <div class="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-zinc-700 mb-3">
            <div class="flex items-center gap-2 font-medium text-sm">
              <i class="fa-solid fa-tag text-blue-600" />
              <span>{{ t('version.title') }}</span>
            </div>
            <button class="text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200" @click="showVersion = false">
              <i class="fa-solid fa-xmark" />
            </button>
          </div>
          <div class="space-y-3 text-xs">
            <div
              v-for="r in releaseList" :key="r.version"
              class="pl-3 py-0.5 border-l-2"
              :class="r.current ? 'border-blue-600' : 'border-slate-300 dark:border-zinc-600 text-slate-400 dark:text-zinc-500'"
            >
              <div class="font-medium" :class="r.current ? 'text-slate-900 dark:text-white' : ''">{{ r.version }}</div>
              <div class="text-[11px] mt-0.5" :class="r.current ? 'text-slate-500 dark:text-zinc-400' : ''">{{ t(r.desc) }}</div>
            </div>
          </div>
          <button class="mt-5 w-full py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-xs text-white font-medium"
                  @click="showVersion = false">{{ t('common.know') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 客户区点阵底纹（code.html 同款 radial-gradient） */
.client-grid {
  background-image: radial-gradient(#e2e8f0 1px, transparent 1px);
  background-size: 24px 24px;
}
:global(.dark) .client-grid {
  background-image: radial-gradient(#3f3f46 1px, transparent 1px);
}

/* 状态栏跑马灯 */
@keyframes marqueeAnimation {
  0% { transform: translateX(100%); }
  100% { transform: translateX(-100%); }
}
.status-marquee {
  display: inline-block;
  white-space: nowrap;
  animation: marqueeAnimation 16s linear infinite;
  will-change: transform;
}
.status-marquee:hover {
  animation-play-state: paused;
}
</style>
