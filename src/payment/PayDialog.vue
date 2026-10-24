<script setup lang="ts">
/* =============================================================================
 * PayDialog.vue —— 通用收银台弹窗（V免签 · 功能限制支付）
 *
 * 布局规范（对应支付规则文档）：
 *   {appName}收银台 → 实际支付金额(大字) → 微信/支付宝切换 → 本地固定二维码
 *   → 倒计时(300s 红色大字) → 订单号 → 取消按钮
 *
 * 关键行为：
 *   - 打开即默认微信支付，自动创建订单 + 开始 3s 轮询 + 倒计时
 *   - 切换渠道 = 关旧订单 → 建新订单（同一弹窗内金额/订单重新生成）
 *   - 展示金额用服务端返回的 reallyPrice（实际支付金额，含随机分），
 *     绝不显示本地猜的值 —— 「支付金额必须是实际值金额」
 *   - 轮询 state=1 → 支付成功；state=-1 → 订单过期；倒计时归零 → 关单并提示超时
 *   - 取消 / 关闭弹窗 → 主动关闭 V免签 订单，不留死单
 *   - 所有定时器在关闭/卸载时清理，异步回调带 session 校验，切换渠道不会串单
 * ========================================================================== */
import { computed, onUnmounted, ref, watch } from 'vue'
import { VmqPay, genPayId, type PayChannel, type VmqOrder } from './vmq'
import { t } from '../i18n'

const props = withDefaults(
  defineProps<{
    /** v-model:open */
    open: boolean
    /** 软件名，标题显示为「{appName}收银台」 */
    appName?: string
    /** 直接覆盖标题 */
    title?: string
    /** 支付金额（元）。注意：展示金额以服务端 reallyPrice 为准 */
    price?: number | string
    /** 商品 ID 模式（服务端校验价格，更安全）；传了则忽略 price */
    productId?: string
    /** 倒计时秒数，默认 5 分钟 */
    expiresIn?: number
    /** 轮询间隔，默认 3 秒（V免签 标准值） */
    pollInterval?: number
    /** V免签 配置（换软件换自己的 appId/appSecret） */
    payConfig?: { apiHost?: string; appId?: string; appSecret?: string }
    /** 本地固定二维码图片路径 */
    qrImages?: { wechat?: string; alipay?: string }
  }>(),
  {
    appName: '',
    title: '',
    price: 0,
    productId: '',
    expiresIn: 300,
    pollInterval: 3000,
    payConfig: undefined,
    qrImages: undefined,
  },
)

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'success', order: VmqOrder): void
  (e: 'cancel'): void
  (e: 'expired'): void
  (e: 'error', msg: string): void
}>()

const pay = new VmqPay(props.payConfig ?? {})
const QR = { wechat: '/pay/weixin.png', alipay: '/pay/zhifubao.png', ...props.qrImages }

// ── 状态机：creating 建单中 / paying 待支付 / success 成功 / expired 超时 / error 失败 ──
type Phase = 'creating' | 'paying' | 'success' | 'expired' | 'error'
const phase = ref<Phase>('creating')
const channel = ref<PayChannel>(1) // 默认微信支付
const order = ref<VmqOrder | null>(null)
const remain = ref(props.expiresIn)
const errorMsg = ref('')

const titleText = computed(() => props.title || t('pay.title', { name: props.appName || t('pay.appName') }))
/** 创建订单用金额：统一格式化为两位小数 */
const priceStr = computed(() => Number(props.price ?? 0).toFixed(2))
/** 实际支付金额：仅在创建订单完成后显示服务端返回的 reallyPrice（含 V免签 加的随机分）。
 *  订单创建完成前一律不显示任何金额数字（含本地预估价），避免用户按未确认金额付款 */
const displayAmount = computed(() => order.value?.reallyPrice ?? '')
const qrSrc = computed(() => (channel.value === 1 ? QR.wechat : QR.alipay))

const mmss = computed(() => {
  const s = Math.max(0, remain.value)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
})
const countdownText = computed(() => {
  if (phase.value === 'success') return t('pay.countdown.success')
  if (phase.value === 'expired') return t('pay.countdown.expired')
  if (phase.value === 'error') return t('pay.countdown.error')
  return mmss.value
})
const statusText = computed(() => {
  switch (phase.value) {
    case 'creating': return t('pay.status.creating')
    case 'paying': return t('pay.status.paying', {
      channel: t(channel.value === 1 ? 'pay.channel.wechat' : 'pay.channel.alipay'),
    })
    case 'success': return t('pay.status.success')
    case 'expired': return t('pay.status.expired')
    case 'error': return errorMsg.value || t('pay.status.error')
  }
})

// ── 定时器与并发控制：session 令牌防止「切换渠道后旧回调写新状态」──────────
let session = 0
let pollTimer: ReturnType<typeof setInterval> | undefined
let tickTimer: ReturnType<typeof setInterval> | undefined

function stopTimers() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined }
  if (tickTimer) { clearInterval(tickTimer); tickTimer = undefined }
}

/** 关单守卫：一次支付会话只发起一次 closeOrder（取消+watch 可能连续触发） */
let closeRequested = false
function closeOrderQuietly() {
  const o = order.value
  if (o && phase.value === 'paying' && !closeRequested) {
    closeRequested = true
    pay.closeOrder(o.orderId).catch(() => {})
  }
}

async function createAndPoll(type: PayChannel) {
  const my = ++session
  phase.value = 'creating'
  order.value = null
  remain.value = props.expiresIn
  errorMsg.value = ''
  closeRequested = false
  try {
    const o = await pay.createOrder({
      payId: genPayId(),
      type,
      ...(props.productId ? { productId: props.productId } : { price: priceStr.value }),
      param: '',
    })
    if (my !== session) {
      // 等待期间被切换/关闭：静默关掉这张多余订单
      pay.closeOrder(o.orderId).catch(() => {})
      return
    }
    order.value = o
    phase.value = 'paying'
    startTimers(my)
  } catch (err) {
    if (my !== session) return
    phase.value = 'error'
    errorMsg.value = err instanceof Error ? err.message : t('pay.status.error')
    emit('error', errorMsg.value)
  }
}

function startTimers(my: number) {
  stopTimers()
  // 倒计时：每秒递减
  tickTimer = setInterval(() => {
    if (my !== session) return stopTimers()
    remain.value--
    if (remain.value <= 0) {
      stopTimers()
      closeOrderQuietly()
      phase.value = 'expired'
      emit('expired')
      setTimeout(() => { if (my === session) closeDialog(false) }, 1200)
    }
  }, 1000)
  // 轮询订单状态（V免签 标准 3 秒）
  pollTimer = setInterval(async () => {
    if (my !== session || !order.value) return stopTimers()
    try {
      const st = await pay.checkOrder(order.value.orderId)
      if (my !== session) return
      if (st.state === 1) {
        stopTimers()
        phase.value = 'success'
        if (order.value) emit('success', order.value)
        setTimeout(() => { if (my === session) closeDialog(false) }, 1500)
      } else if (st.state === -1) {
        stopTimers()
        phase.value = 'expired'
        emit('expired')
      }
    } catch {
      // 单次查询失败不打断轮询（网络抖动容错）
    }
  }, props.pollInterval)
}

/** 切换微信/支付宝：关旧单 → 建新单（同一次支付意图重新发起） */
function switchChannel(t: PayChannel) {
  if (t === channel.value || phase.value === 'success' || phase.value === 'expired') return
  channel.value = t
  session++
  stopTimers()
  closeOrderQuietly()
  createAndPoll(t)
}

function closeDialog(byUser: boolean) {
  session++
  stopTimers()
  closeOrderQuietly()
  if (byUser) emit('cancel')
  emit('update:open', false)
}

// ── 生命周期：open 变化驱动（immediate 覆盖「挂载时即打开」的场景）────────
watch(
  () => props.open,
  (v) => {
    if (v) {
      channel.value = 1 // 每次打开默认微信支付
      createAndPoll(1)
    } else {
      session++
      stopTimers()
      closeOrderQuietly()
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  session++
  stopTimers()
  closeOrderQuietly()
})
</script>

<template>
  <div
    v-show="open"
    class="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-[70] flex items-center justify-center p-4"
    @click.self="closeDialog(true)"
  >
    <div class="w-full max-w-sm bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-xl shadow-2xl p-6 select-none">
      <!-- 标题 -->
      <h3 class="text-center text-base font-semibold text-slate-900 dark:text-white">{{ titleText }}</h3>

      <!-- 实际支付金额（创建订单完成后才显示服务端返回的真实金额） -->
      <div class="mt-3 text-center">
        <div class="text-[11px] text-slate-500 dark:text-zinc-400">{{ t('pay.amountLabel') }}</div>
        <div v-if="displayAmount" class="text-4xl font-bold text-blue-600 dark:text-blue-400 tabular-nums mt-0.5">¥ {{ displayAmount }}</div>
        <div v-else class="text-sm font-medium text-slate-400 dark:text-zinc-500 mt-1.5">{{ t('pay.amountPending') }}</div>
      </div>

      <!-- 微信 / 支付宝切换 -->
      <div class="mt-5 flex justify-center gap-3">
        <button
          class="w-[132px] h-11 rounded-lg inline-flex items-center justify-center gap-2 text-sm font-medium border transition-colors"
          :class="channel === 1
            ? 'bg-blue-600 border-blue-600 text-white'
            : 'bg-white dark:bg-zinc-800 border-slate-200 dark:border-zinc-600 text-slate-600 dark:text-zinc-300 hover:border-blue-400'"
          :disabled="phase === 'success'"
          @click="switchChannel(1)"
        >
          <i class="fa-brands fa-weixin text-base" :class="channel === 1 ? 'text-white' : 'text-green-500'" />
          {{ t('pay.wechat') }}
        </button>
        <button
          class="w-[132px] h-11 rounded-lg inline-flex items-center justify-center gap-2 text-sm font-medium border transition-colors"
          :class="channel === 2
            ? 'bg-blue-600 border-blue-600 text-white'
            : 'bg-white dark:bg-zinc-800 border-slate-200 dark:border-zinc-600 text-slate-600 dark:text-zinc-300 hover:border-blue-400'"
          :disabled="phase === 'success'"
          @click="switchChannel(2)"
        >
          <i class="fa-brands fa-alipay text-base" :class="channel === 2 ? 'text-white' : 'text-blue-500'" />
          {{ t('pay.alipay') }}
        </button>
      </div>

      <!-- 本地固定收款二维码 -->
      <div class="mt-5 flex justify-center">
        <div class="p-2.5 bg-white border border-slate-200 dark:border-zinc-600 rounded-lg">
          <img
            :src="qrSrc"
            class="w-[210px] h-[210px] object-contain"
            draggable="false"
            :alt="t('pay.qrAlt')"
            @error="(e: Event) => (e.target as HTMLImageElement).style.opacity = '0.15'"
          >
        </div>
      </div>

      <!-- 倒计时 -->
      <div
        class="mt-4 text-center text-3xl font-bold tabular-nums"
        :class="phase === 'success' ? 'text-green-600 dark:text-green-400' : 'text-red-500'"
      >
        {{ countdownText }}
      </div>

      <!-- 状态提示 + 订单号 -->
      <div class="mt-1.5 text-center text-[11px] text-slate-500 dark:text-zinc-400">{{ statusText }}</div>
      <div v-if="order" class="mt-1 text-center text-[10px] text-slate-400 dark:text-zinc-500 font-mono truncate px-4">
        {{ t('pay.orderNo') }} {{ order.orderId }}
      </div>

      <!-- 取消支付 -->
      <button
        class="mt-5 w-full py-2 rounded-lg bg-slate-100 dark:bg-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-600
               text-slate-700 dark:text-zinc-200 text-sm font-medium transition-colors"
        @click="closeDialog(true)"
      >
        {{ t('pay.cancel') }}
      </button>
    </div>
  </div>
</template>
