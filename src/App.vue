<script setup lang="ts">
/**
 * App.vue —— 装配器（框架核心与对接文件之间的胶水，完整版基本不用动）。
 *
 * 完整版开发三步（都不改本文件与框架核心）：
 *   1. 改 src/config/app.config.ts   —— 软件身份 / 界面 / 支付定价
 *   2. 改 src/config/app.commands.ts  —— 注册业务命令 / 追加菜单
 *   3. 在下方 <BaseWindow> 默认插槽里放业务组件或 <RouterView />
 */
import { onMounted, ref, watch, provide } from 'vue'
import { t, locale as appLocale } from './i18n'
import BaseWindow from './layouts/BaseWindow.vue'
import PayDialog from './payment/PayDialog.vue'
import RepairWorkbench from './features/RepairWorkbench.vue'
import type { VmqOrder } from './payment/vmq'
import { appConfig } from './config/app.config'
import { setupCommands, extraMenus } from './config/app.commands'
import { licenseSave, licenseLoad, settingsLoad, settingsSave, setAppLocale } from './tauri'

const win = ref<InstanceType<typeof BaseWindow> | null>(null)
const payOpen = ref(false)
/** 授权状态：支付成功落盘后，重启仍保持已解锁 */
const unlocked = ref(false)
/** 关闭行为：与 Rust 侧 settings.json 同步（默认最小化到托盘） */
const closeBehavior = ref<'tray' | 'quit'>('tray')

/** 语言切换 → 同步 Rust 侧托盘菜单语言（i18n 全覆盖，托盘文案不硬编码） */
watch(appLocale, (l) => {
  void setAppLocale(l)
})

onMounted(async () => {
  const w = win.value
  if (!w) return
  // 把对接文件里注册的命令挂到窗口命令总线
  const handlers = setupCommands({ win: w, openPay: () => (payOpen.value = true) })
  for (const [id, fn] of Object.entries(handlers)) w.on(id, fn)
  // 追加对接文件声明的增量菜单
  extraMenus.forEach((m) => w.addMenu(m))

  // 启动即同步界面语言到 Rust 侧（托盘菜单即时跟随）
  void setAppLocale(appLocale.value)

  // 启动即恢复授权态与关闭行为（Rust 侧已持久化）
  const lic = await licenseLoad()
  if (lic) unlocked.value = true
  const settings = await settingsLoad()
  if (settings) closeBehavior.value = settings.closeBehavior
})

// 向客户区组件（照片修复等）暴露解锁态与唤起收银台的能力（provide/inject 解耦）
provide('unlocked', unlocked)
provide('openPay', () => {
  payOpen.value = true
})

/** 支付成功：写解锁凭证（Rust 侧绑定机器码落盘），并立即刷新 UI 解锁态 */
async function onPaySuccess(order: VmqOrder) {
  console.info('[App] 支付成功，订单:', order.orderId, '金额:', order.reallyPrice)
  await licenseSave(order.orderId)
  unlocked.value = true
}

/** 设置弹窗里切换「关闭行为」→ 同步到 Rust 侧持久化 */
function onCloseBehaviorChange(v: 'tray' | 'quit') {
  closeBehavior.value = v
  settingsSave({ closeBehavior: v })
}

/** 未被 setupCommands 接管的命令最终冒泡到这里（兜底日志，便于排查） */
function onUnhandled(id: string) {
  console.info('[App] 未注册命令:', id)
}
</script>

<template>
  <BaseWindow
    ref="win"
    :brand="appConfig.brand"
    :about="appConfig.about"
    :help-items="appConfig.helpItems"
    :menus="appConfig.menus"
    :context-menu="appConfig.contextMenu"
    :releases="appConfig.releases"
    :status-text="appConfig.statusText"
    :default-theme="appConfig.defaultTheme"
    :status-bar-visible="appConfig.statusBarVisible"
    :close-behavior="closeBehavior"
    @command="onUnhandled"
    @update:close-behavior="onCloseBehaviorChange"
  >
    <!-- ===== 客户区：照片模糊修复高清 业务组件（通用修复 / 人像超清修复 两个页签） ===== -->
    <RepairWorkbench />

    <!-- 状态栏右侧固定信息：版本号 + 授权状态 -->
    <template #status-right>
      <span class="text-[10px] text-slate-400">{{ appConfig.statusRight }}</span>
      <span
        class="text-[10px] px-1.5 py-0.5 rounded"
        :class="unlocked ? 'bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400' : 'bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400'"
      >{{ unlocked ? t('license.unlocked') : t('license.locked') }}</span>
    </template>
  </BaseWindow>

  <!-- 收银台：appName/金额/凭据全部来自 app.config.ts（凭据经 Rust 侧签名，前端不接触 appSecret） -->
  <PayDialog
    v-model:open="payOpen"
    :app-name="appConfig.pay.appName"
    :price="appConfig.pay.price"
    :product-id="appConfig.pay.productId"
    :expires-in="appConfig.pay.expiresIn"
    :poll-interval="appConfig.pay.pollInterval"
    :pay-config="appConfig.pay.config"
    @success="onPaySuccess"
  />
</template>
