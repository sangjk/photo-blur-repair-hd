/* =============================================================================
 * vmq.ts —— V免签 (VMQ) 个人收款网关对接（App Proxy 模式）
 *
 * 接口约定（来自 V免签 官方规则）：
 *   创建订单  POST {apiHost}/api/pay/create
 *             sign = md5(payId + param + type + price + appSecret)
 *             （走 productId 时 sign = md5(payId + param + type + productId + appSecret)）
 *   查询订单  GET  {apiHost}/api/pay/check/{orderId}?appId=xxx&sign=xxx
 *             sign = md5(orderId + appSecret)
 *   关闭订单  POST {apiHost}/api/pay/close/{orderId}   body: { appId, sign }
 *   type: 1=微信 2=支付宝；param 为空必须传 ""（不是 "null"）
 *   state: 0=未支付 1=已支付 -1=已关闭/过期
 *
 * 跨域（CORS）铁律——三个环境三条通路，禁止直连：
 *   1. Tauri 生产环境：经 Rust vmq_proxy（reqwest）转发，无 CORS；
 *   2. 浏览器 dev（npm run dev）：走 vite.config.ts 的 /vmq 同源代理转发，无 CORS；
 *   3. 禁止在任何前端代码里直接 fetch(支付网关域名) —— 必被浏览器/WebView 拦截，
 *      表现为「订单创建失败」。新增支付相关网络请求一律复用本文件的 request()。
 * ========================================================================== */

/** 支付渠道：1=微信支付 2=支付宝 */
import { isTauri, vmqPublicConfig, vmqSign, vmqProxy } from '../tauri'

// ── 凭据外置：浏览器下用本地默认凭据 + 本地 md5 演示；Tauri 下从 Rust 取配置与签名（前端不接触 appSecret）──
let _publicCache: { apiHost: string; appId: string } | null = null
async function resolveConfig(): Promise<{ apiHost: string; appId: string }> {
  if (!isTauri()) return { apiHost: DEFAULT_VMQ_CONFIG.apiHost, appId: DEFAULT_VMQ_CONFIG.appId }
  if (!_publicCache) {
    const cfg = await vmqPublicConfig()
    // 兜底：Rust 返回的字段缺失（命名错位 → undefined）时回退默认配置，
    // 绝不让 undefined 进入请求体（JSON.stringify 丢字段 → 服务端报「参数不完整」）
    _publicCache =
      cfg && cfg.apiHost && cfg.appId
        ? { apiHost: cfg.apiHost, appId: cfg.appId }
        : { apiHost: DEFAULT_VMQ_CONFIG.apiHost, appId: DEFAULT_VMQ_CONFIG.appId }
  }
  return _publicCache
}
async function resolveSign(kind: 'create' | 'check' | 'close', params: string[]): Promise<string> {
  if (isTauri()) {
    const s = await vmqSign(kind, params)
    if (s) return s
  }
  // 浏览器回退：本地 md5（appSecret 为默认占位，仅演示用；Tauri 下不会走到这里）
  const joined =
    kind === 'create'
      ? `${params[0]}${params[1]}${params[2]}${params[3]}${DEFAULT_VMQ_CONFIG.appSecret}`
      : `${params[0]}${DEFAULT_VMQ_CONFIG.appSecret}`
  return md5(joined)
}

export type PayChannel = 1 | 2

export interface VmqConfig {
  apiHost: string
  appId: string
  appSecret: string
}

/** 默认凭据：TASK.md 第 3 项未更新（模板示例值 app_aad7d7f284e6）时必须保留本默认值——示例值无效会导致「创建订单失败」。Tauri 下实际使用 Rust 侧 vmq_config()，此处仅浏览器演示回退用 */
export const DEFAULT_VMQ_CONFIG: VmqConfig = {
  apiHost: 'https://laosanvmianqianzhuanyong1.ifama.top',
  appId: 'app_1a81bec92e7e',
  appSecret: 'bb1e58459236f006f5f7e518dca91b06',
}

export interface VmqOrder {
  payId: string
  orderId: string
  payType: number
  price: string
  /** 实际支付金额（V免签 会加随机分用于订单匹配，展示金额以此为准） */
  reallyPrice: string
  payUrl: string
  isAuto: number
  redirectUrl: string
}

export interface VmqOrderStatus {
  state: number
  stateText: string
  price: string
  reallyPrice: string
  remainingSeconds: number
}

interface VmqResp<T> {
  code: number
  msg: string
  data: T
}

// =============================================================================
// MD5（RFC 1321）—— 自包含实现，避免为一个签名引入第三方依赖
// =============================================================================
function safeAdd(x: number, y: number): number {
  const lsw = (x & 0xffff) + (y & 0xffff)
  const msw = (x >> 16) + (y >> 16) + (lsw >> 16)
  return (msw << 16) | (lsw & 0xffff)
}
function bitRotateLeft(num: number, cnt: number): number {
  return (num << cnt) | (num >>> (32 - cnt))
}
function md5cmn(q: number, a: number, b: number, x: number, s: number, t: number): number {
  return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b)
}
function md5ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return md5cmn((b & c) | (~b & d), a, b, x, s, t)
}
function md5gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return md5cmn((b & d) | (c & ~d), a, b, x, s, t)
}
function md5hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return md5cmn(b ^ c ^ d, a, b, x, s, t)
}
function md5ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return md5cmn(c ^ (b | ~d), a, b, x, s, t)
}
function md5cycle(x: number[], k: number[]): void {
  let [a, b, c, d] = x
  a = md5ff(a, b, c, d, k[0], 7, -680876936)
  d = md5ff(d, a, b, c, k[1], 12, -389564586)
  c = md5ff(c, d, a, b, k[2], 17, 606105819)
  b = md5ff(b, c, d, a, k[3], 22, -1044525330)
  a = md5ff(a, b, c, d, k[4], 7, -176418897)
  d = md5ff(d, a, b, c, k[5], 12, 1200080426)
  c = md5ff(c, d, a, b, k[6], 17, -1473231341)
  b = md5ff(b, c, d, a, k[7], 22, -45705983)
  a = md5ff(a, b, c, d, k[8], 7, 1770035416)
  d = md5ff(d, a, b, c, k[9], 12, -1958414417)
  c = md5ff(c, d, a, b, k[10], 17, -42063)
  b = md5ff(b, c, d, a, k[11], 22, -1990404162)
  a = md5ff(a, b, c, d, k[12], 7, 1804603682)
  d = md5ff(d, a, b, c, k[13], 12, -40341101)
  c = md5ff(c, d, a, b, k[14], 17, -1502002290)
  b = md5ff(b, c, d, a, k[15], 22, 1236535329)

  a = md5gg(a, b, c, d, k[1], 5, -165796510)
  d = md5gg(d, a, b, c, k[6], 9, -1069501632)
  c = md5gg(c, d, a, b, k[11], 14, 643717713)
  b = md5gg(b, c, d, a, k[0], 20, -373897302)
  a = md5gg(a, b, c, d, k[5], 5, -701558691)
  d = md5gg(d, a, b, c, k[10], 9, 38016083)
  c = md5gg(c, d, a, b, k[15], 14, -660478335)
  b = md5gg(b, c, d, a, k[4], 20, -405537848)
  a = md5gg(a, b, c, d, k[9], 5, 568446438)
  d = md5gg(d, a, b, c, k[14], 9, -1019803690)
  c = md5gg(c, d, a, b, k[3], 14, -187363961)
  b = md5gg(b, c, d, a, k[8], 20, 1163531501)
  a = md5gg(a, b, c, d, k[13], 5, -1444681467)
  d = md5gg(d, a, b, c, k[2], 9, -51403784)
  c = md5gg(c, d, a, b, k[7], 14, 1735328473)
  b = md5gg(b, c, d, a, k[12], 20, -1926607734)

  a = md5hh(a, b, c, d, k[5], 4, -378558)
  d = md5hh(d, a, b, c, k[8], 11, -2022574463)
  c = md5hh(c, d, a, b, k[11], 16, 1839030562)
  b = md5hh(b, c, d, a, k[14], 23, -35309556)
  a = md5hh(a, b, c, d, k[1], 4, -1530992060)
  d = md5hh(d, a, b, c, k[4], 11, 1272893353)
  c = md5hh(c, d, a, b, k[7], 16, -155497632)
  b = md5hh(b, c, d, a, k[10], 23, -1094730640)
  a = md5hh(a, b, c, d, k[13], 4, 681279174)
  d = md5hh(d, a, b, c, k[0], 11, -358537222)
  c = md5hh(c, d, a, b, k[3], 16, -722521979)
  b = md5hh(b, c, d, a, k[6], 23, 76029189)
  a = md5hh(a, b, c, d, k[9], 4, -640364487)
  d = md5hh(d, a, b, c, k[12], 11, -421815835)
  c = md5hh(c, d, a, b, k[15], 16, 530742520)
  b = md5hh(b, c, d, a, k[2], 23, -995338651)

  a = md5ii(a, b, c, d, k[0], 6, -198630844)
  d = md5ii(d, a, b, c, k[7], 10, 1126891415)
  c = md5ii(c, d, a, b, k[14], 15, -1416354905)
  b = md5ii(b, c, d, a, k[5], 21, -57434055)
  a = md5ii(a, b, c, d, k[12], 6, 1700485571)
  d = md5ii(d, a, b, c, k[3], 10, -1894986606)
  c = md5ii(c, d, a, b, k[10], 15, -1051523)
  b = md5ii(b, c, d, a, k[1], 21, -2054922799)
  a = md5ii(a, b, c, d, k[8], 6, 1873313359)
  d = md5ii(d, a, b, c, k[15], 10, -30611744)
  c = md5ii(c, d, a, b, k[6], 15, -1560198380)
  b = md5ii(b, c, d, a, k[13], 21, 1309151649)
  a = md5ii(a, b, c, d, k[4], 6, -145523070)
  d = md5ii(d, a, b, c, k[11], 10, -1120210379)
  c = md5ii(c, d, a, b, k[2], 15, 718787259)
  b = md5ii(b, c, d, a, k[9], 21, -343485551)

  x[0] = safeAdd(a, x[0])
  x[1] = safeAdd(b, x[1])
  x[2] = safeAdd(c, x[2])
  x[3] = safeAdd(d, x[3])
}
function md5blk(s: string): number[] {
  const blocks = new Array<number>(16)
  for (let i = 0; i < 16; i++) {
    blocks[i] =
      s.charCodeAt(i * 4) +
      s.charCodeAt(i * 4 + 1) * 256 +
      s.charCodeAt(i * 4 + 2) * 65536 +
      s.charCodeAt(i * 4 + 3) * 16777216
  }
  return blocks
}
function rhex(n: number): string {
  let s = ''
  for (let j = 0; j < 4; j++) {
    s += ((n >> (j * 8 + 4)) & 0x0f).toString(16) + ((n >> (j * 8)) & 0x0f).toString(16)
  }
  return s
}

/** UTF-8 感知的 MD5（param 可能含中文） */
export function md5(input: string): string {
  // 先转 UTF-8 字节再按字节参与运算
  const str = Array.from(new TextEncoder().encode(input))
    .map((b) => String.fromCharCode(b))
    .join('')
  const n = str.length
  const state = [1732584193, -271733879, -1732584194, 271733878]
  let i: number
  for (i = 64; i <= n; i += 64) {
    md5cycle(state, md5blk(str.substring(i - 64, i)))
  }
  const tail = new Array<number>(16).fill(0)
  const rest = str.substring(i - 64)
  for (i = 0; i < rest.length; i++) tail[i >> 2] |= rest.charCodeAt(i) << ((i % 4) << 3)
  tail[i >> 2] |= 0x80 << ((i % 4) << 3)
  if (i > 55) {
    md5cycle(state, tail)
    tail.fill(0)
  }
  tail[14] = n * 8
  md5cycle(state, tail)
  return state.map(rhex).join('')
}

// =============================================================================
// V免签 API 客户端
// =============================================================================
export interface CreateOrderOptions {
  /** 商户订单号，必须唯一 */
  payId: string
  type: PayChannel
  /** 金额（元），与 productId 二选一 */
  price?: string
  /** 商品 ID（服务端校验价格，更安全），与 price 二选一 */
  productId?: string
  /** 透传参数，默认空串（绝不能传 "null"） */
  param?: string
  notifyUrl?: string
}

export class VmqPay {
  readonly config: VmqConfig

  constructor(config: Partial<VmqConfig> = {}) {
    this.config = { ...DEFAULT_VMQ_CONFIG, ...config }
  }

  /**
   * 统一请求：Tauri 下经 Rust vmq_proxy（reqwest）转发，彻底绕开 WebView/浏览器 CORS；
   * 浏览器 dev 走 vite /vmq 同源代理，同样无 CORS。统一 15 秒超时，避免服务挂起时订单卡死。
   * @param apiHost 仅非 dev 纯浏览器直连时拼接用；Tauri 下由 Rust 侧读取配置，前端不参与拼 host
   * @param path    以 /api/ 开头的相对路径（可带 query）
   */
  private async request<T>(apiHost: string, path: string, init?: RequestInit): Promise<VmqResp<T>> {
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = typeof init?.body === 'string' ? init.body : null

    let rawText: string
    if (isTauri()) {
      // Rust 侧 reqwest 发起，不受 WebView CORS 限制；超时由 Rust 端 15s 控制
      const resp = await vmqProxy({ path, method, headers, body })
      rawText = resp.body
    } else {
      // 浏览器 dev：走 vite.config.ts 的 /vmq 同源代理（rewrite 到 apiHost），绕开 CORS。
      // 非 dev 的纯浏览器场景（极少见）才直连 apiHost——若服务端未放开跨域会失败，
      // 此时应部署自己的后端转发，而不是在前端绕过。
      const base = import.meta.env.DEV ? '/vmq' : apiHost
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 15000)
      try {
        const res = await fetch(`${base}${path}`, { ...init, signal: ctrl.signal })
        rawText = await res.text()
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new Error('V免签接口请求超时（15s），请检查网络或服务端')
        }
        throw err
      } finally {
        clearTimeout(timer)
      }
    }

    let data: VmqResp<T>
    try {
      data = JSON.parse(rawText) as VmqResp<T>
    } catch {
      throw new Error('V免签接口返回非 JSON，请检查 apiHost 或服务端')
    }
    if (data.code !== 200) throw new Error(data.msg || `V免签接口错误 code=${data.code}`)
    return data
  }

  /** 创建订单；成功返回订单信息（含实际支付金额 reallyPrice） */
  async createOrder(opts: CreateOrderOptions): Promise<VmqOrder> {
    const cfg = await resolveConfig()
    const param = opts.param ?? ''
    const amount = opts.productId ?? opts.price ?? ''
    if (!amount) throw new Error('price 与 productId 必须二选一')
    // 签名由 Rust 侧用 appSecret 完成；浏览器回退本地 md5。前端不持有密钥。
    const sign = await resolveSign('create', [opts.payId, param, String(opts.type), amount])
    const body = {
      appId: cfg.appId,
      payId: opts.payId,
      type: String(opts.type),
      ...(opts.productId ? { productId: opts.productId } : { price: opts.price }),
      param,
      ...(opts.notifyUrl ? { notifyUrl: opts.notifyUrl } : {}),
      sign,
      isHtml: '0',
    }
    const resp = await this.request<VmqOrder>(cfg.apiHost, '/api/pay/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return resp.data
  }

  /** 查询订单状态：state 0=未支付 1=已支付 -1=已关闭/过期 */
  async checkOrder(orderId: string): Promise<VmqOrderStatus> {
    const cfg = await resolveConfig()
    const sign = await resolveSign('check', [orderId])
    const resp = await this.request<VmqOrderStatus>(
      cfg.apiHost,
      `/api/pay/check/${orderId}?appId=${encodeURIComponent(cfg.appId)}&sign=${sign}`,
    )
    return resp.data
  }

  /** 关闭订单（用户取消 / 切换渠道 / 超时清理） */
  async closeOrder(orderId: string): Promise<boolean> {
    const cfg = await resolveConfig()
    const sign = await resolveSign('close', [orderId])
    const resp = await this.request<unknown>(cfg.apiHost, `/api/pay/close/${orderId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: cfg.appId, sign }),
    })
    return resp.code === 200
  }
}

/** 生成商户订单号（payId）：时间戳 + 随机数，保证唯一 */
export function genPayId(prefix = 'PAY'): string {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000000)}`
}
